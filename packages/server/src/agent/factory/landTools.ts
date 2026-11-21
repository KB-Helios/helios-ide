import { randomUUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { linkDependencies, runCommand, unlinkDependencies } from "pi-swarm";
import { Type } from "typebox";
import { boundFor, toolResult } from "./access";
import type { FactoryRun, WorktreeMeta } from "./run";
import { contentTree, hasCommit } from "./snapshot";
import { FACTORY_TOOL } from "./spec";

export interface LandedSource {
	node: string;
	status: "landed" | "unchanged" | "already-landed";
	commit?: string;
	/** The worktree held edits made after the final gate check: kept (with its branch), never deleted. */
	keptWorktree?: true;
}

const IDENTITY = ["-c", "user.name=ThinkRail", "-c", "user.email=agents@thinkrail.invalid"];

async function git(cwd: string, args: string[], env?: Record<string, string>) {
	return runCommand("git", args, { cwd, ...(env ? { env } : {}) });
}

/**
 * Runs `use` while holding the checkout's `index.lock` on a private copy of the index; when `use` returns
 * true the copy becomes the index (git's lock-and-rename protocol). It blocks index writes, not every HEAD
 * change (`acquireHeadLock` covers those). A lock someone else holds means git is busy there: nothing is done.
 * `use` may hand over locks to release only after the copy is installed (`holdUntilInstalled`), so a HEAD lock
 * it took covers the installation too. `beforeInstall` is a test seam for exactly that interval.
 */
async function withIndexLock(
	repo: string,
	use: (index: string, holdUntilInstalled: (release: () => void) => void) => Promise<boolean>,
	beforeInstall?: () => Promise<void>,
): Promise<void> {
	const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
	const index = join(gitDir, "index");
	const lock = `${index}.lock`;
	let fd: number;
	try {
		fd = openSync(lock, "wx");
	} catch {
		throw new Error(
			"Git is busy in your checkout (its index is locked); nothing was changed. Land again when it is done.",
		);
	}
	const copy = join(gitDir, `factory-index-${randomUUID()}`);
	const releases: (() => void)[] = [];
	let committed = false;
	try {
		if (existsSync(index)) copyFileSync(index, copy);
		if (await use(copy, (release) => releases.push(release))) {
			await beforeInstall?.();
			writeSync(fd, readFileSync(copy));
			closeSync(fd);
			renameSync(lock, index);
			committed = true;
		}
	} finally {
		if (!committed) {
			try {
				closeSync(fd);
			} catch {}
			rmSync(lock, { force: true });
		}
		rmSync(copy, { force: true });
		for (const release of releases.reverse()) release();
	}
}

/**
 * Takes git's `HEAD.lock` and returns the function that releases it, so no branch switch can complete while it
 * is held. The lock is only held, never committed: HEAD itself is not changed. Someone else's commit or switch
 * may hold it for a moment, so this retries briefly before giving up.
 */
async function acquireHeadLock(
	repo: string,
	target: string,
	tips: { from: string; to: string },
): Promise<() => void> {
	const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
	const lock = join(gitDir, "HEAD.lock");
	let fd: number | undefined;
	for (let attempt = 0; fd === undefined; attempt++) {
		try {
			fd = openSync(lock, "wx");
		} catch {
			if (attempt >= 40)
				throw new Error(
					`Landed on ${target} (${tips.from} -> ${tips.to}), but git kept your checkout busy, so it was not brought along; when git is done, run "git read-tree -m -u ${tips.from} ${tips.to}" in your checkout.`,
				);
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	const held = fd;
	return () => {
		closeSync(held);
		rmSync(lock, { force: true });
	};
}

async function mergeIdentity(cwd: string): Promise<string[]> {
	return (await git(cwd, ["config", "user.email"])).code === 0 ? [] : IDENTITY;
}

async function mergeInProgress(repo: string): Promise<boolean> {
	return (await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
}

async function currentBranch(repo: string): Promise<string> {
	return (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
}

async function assertTarget(repo: string, target: string): Promise<void> {
	const branch = await currentBranch(repo);
	if (branch !== target)
		throw new Error(`The checkout is on ${branch || "a detached HEAD"}, not the target ${target}.`);
	if (await mergeInProgress(repo))
		throw new Error(
			"The target checkout has a merge in progress; finish or abort it before landing factory work.",
		);
}

function statusPaths(porcelainZ: string): string[] {
	const paths: string[] = [];
	const records = porcelainZ.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] ?? "";
		if (record.length < 4) continue;
		paths.push(record.slice(3));
		// A rename or copy carries its original path as the next record. A rename changes that path too;
		// a copy leaves its source as it was.
		if (record[0] === "R" || record[1] === "R") {
			const from = records[i + 1];
			if (from) paths.push(from);
			i++;
		} else if (record[0] === "C" || record[1] === "C") i++;
	}
	return paths;
}

/**
 * Lands `sha` on `target` without ever running `git merge` in the person's checkout, so a branch switch
 * there cannot redirect it. The merge runs in a throwaway detached checkout of the target's tip (a conflict
 * is aborted there and never touches the person's files); the target ref then moves by compare-and-swap,
 * only if it still points at that tip. When the person's checkout has the target checked out, its index and
 * files are brought from the old tip to the new one (`read-tree -m -u`, which refuses rather than overwrite),
 * after a check that their local edits do not touch the landed files. Returns the new tip.
 */
export async function landOnTarget(
	repo: string,
	scratchRoot: string,
	target: string,
	sha: string,
	message: string,
	/** Test seams: right after the ref update, and inside the HEAD lock right after the target check. */
	hooks?: {
		afterRefUpdate?: () => Promise<void>;
		insideCheckoutLock?: () => Promise<void>;
		/** After the sync, with the HEAD lock still held, right before the private index is installed. */
		beforeIndexInstall?: () => Promise<void>;
	},
	/**
	 * `expectedTip`: the commit the target must be at (the one a gate run validated); anything else refuses
	 * before a merge is made, so the ref compare-and-swap protects the tested base, not whatever the tip is
	 * now. `intent` runs right before the ref update with the move about to be made, so a stop after the
	 * update leaves a record the next landing can recognise.
	 */
	options?: { expectedTip?: string; intent?: (move: { from: string; to: string }) => void },
): Promise<string> {
	const ref = `refs/heads/${target}`;
	const resolved = await git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
	if (resolved.code !== 0) throw new Error(`The target branch ${target} does not exist.`);
	const tip = resolved.stdout.trim();
	if (options?.expectedTip && tip !== options.expectedTip)
		throw new Error(
			`${target} is no longer at the commit the combined gates tested; nothing was changed.`,
		);
	const path = join(scratchRoot, ".landing", randomUUID());
	mkdirSync(dirname(path), { recursive: true });
	const added = await git(repo, ["worktree", "add", "--detach", path, tip]);
	if (added.code !== 0)
		throw new Error(
			`Could not prepare the landing checkout: ${(added.stderr || added.stdout).trim()}`,
		);
	let merged: string;
	try {
		const result = await git(path, [
			...(await mergeIdentity(repo)),
			"merge",
			"--no-ff",
			"-m",
			message,
			sha,
		]);
		if (result.code !== 0) {
			await git(path, ["merge", "--abort"]);
			throw new Error(
				`Merging into ${target} failed; nothing was changed: ${(result.stderr || result.stdout).trim()}`,
			);
		}
		merged = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
	} finally {
		await git(repo, ["worktree", "remove", "--force", path]);
		rmSync(path, { recursive: true, force: true });
	}

	// Git's own index lock is held across the target check, the ref update and the sync: a branch switch in
	// the person's checkout needs the same lock, so it can neither slip in between nor receive the sync.
	await withIndexLock(
		repo,
		async (index, holdUntilInstalled) => {
			const env = { GIT_INDEX_FILE: index };
			const headIs = async (name: string) =>
				(await git(repo, ["symbolic-ref", "-q", "HEAD"])).stdout.trim() === name;
			// Refuse before any change when the person's edits touch a landed file.
			if (await headIs(ref)) {
				const landed = new Set(
					(await git(repo, ["diff", "--name-only", "-z", tip, merged])).stdout
						.split("\0")
						.filter(Boolean),
				);
				const status = await git(
					repo,
					["--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all"],
					env,
				);
				const local = statusPaths(status.stdout).filter((file) => landed.has(file));
				if (local.length)
					throw new Error(
						`Your uncommitted changes touch files this landing changes (${local.join(", ")}); commit or stash them first. Nothing was changed.`,
					);
			}
			// The ref update needs git's HEAD lock itself (HEAD's reflog), so it runs before this host takes that
			// lock. Then HEAD is locked too: a branch switch must write HEAD under that lock, so one that already
			// finished is seen below, and one still in flight (even one that read the old tip) fails instead of
			// landing between the HEAD check and the sync. HEAD cannot change while the sync runs.
			options?.intent?.({ from: tip, to: merged });
			const updated = await git(repo, ["update-ref", "-m", message, ref, merged, tip]);
			if (updated.code !== 0)
				throw new Error(
					/cannot lock ref|\.lock/i.test(updated.stderr)
						? `Git is busy in your checkout (${target} is locked); nothing was changed. Land again when it is done.`
						: `${target} moved while landing; nothing was changed. Land again.`,
				);
			await hooks?.afterRefUpdate?.();
			// Held until the private index is installed too: releasing it earlier leaves a gap in which a switch
			// could write HEAD while the synced index is still about to become the checkout's index.
			holdUntilInstalled(await acquireHeadLock(repo, target, { from: tip, to: merged }));
			const onTarget = await headIs(ref);
			await hooks?.insideCheckoutLock?.();
			if (!onTarget) return false;
			const synced = await git(repo, ["read-tree", "-m", "-u", tip, merged], env);
			if (synced.code !== 0)
				throw new Error(
					`Landed on ${target} (${tip} -> ${merged}), but your checkout could not be brought along: ${(synced.stderr || synced.stdout).trim()}. Move the files it names aside, then run "git read-tree -m -u ${tip} ${merged}" in your checkout to bring it to the landed commit without touching your other edits.`,
				);
			return true;
		},
		hooks?.beforeIndexInstall,
	);
	return merged;
}

/**
 * Removes a landed worktree and its branch only when git agrees it is clean: no forced removal, so an edit
 * saved at any moment up to the removal itself makes git refuse, and the worktree and branch are kept.
 * Dependency links are host-made, not content: they are taken out first and restored when git refuses.
 */
async function removeLandedWorktree(meta: WorktreeMeta): Promise<boolean> {
	unlinkDependencies(meta.path);
	const removed = await git(meta.repo, ["worktree", "remove", meta.path]);
	if (removed.code !== 0) {
		linkDependencies(meta.repo, meta.path);
		return false;
	}
	await git(meta.repo, ["branch", "-D", meta.branch]);
	return true;
}

/**
 * The commit landing would merge for a source: its fresh passing gated snapshot while the worktree holds an
 * uncommitted change, else the commit a landing already made from it; undefined for a source with no change.
 * Throws like `gatedSnapshot` when a change has no fresh passing gate record.
 */
export async function landableCommit(
	run: FactoryRun,
	meta: WorktreeMeta,
): Promise<string | undefined> {
	const dirty = (await run.changed(meta)).files.length > 0;
	return dirty ? gatedSnapshot(run, meta) : meta.committed;
}

/**
 * Merges each commit onto a detached throwaway checkout of `tip`, in order, and returns the combined commit
 * and its tree. The person's checkout is never involved; a conflict is aborted and named.
 */
export async function combineCommits(
	repo: string,
	scratchRoot: string,
	tip: string,
	parts: { node: string; sha: string }[],
): Promise<{ commit: string; tree: string } | { conflict: string }> {
	const path = join(scratchRoot, ".integration", randomUUID());
	mkdirSync(dirname(path), { recursive: true });
	const added = await git(repo, ["worktree", "add", "--detach", path, tip]);
	if (added.code !== 0)
		throw new Error(
			`Could not prepare the combined checkout: ${(added.stderr || added.stdout).trim()}`,
		);
	try {
		const identity = await mergeIdentity(repo);
		for (const { node, sha } of parts) {
			const result = await git(path, [
				...identity,
				"merge",
				"--no-ff",
				"-m",
				`factory: integrate ${node}`,
				sha,
			]);
			if (result.code !== 0) {
				await git(path, ["merge", "--abort"]);
				return {
					conflict: `Merging ${node} into the combined change failed: ${(result.stderr || result.stdout).trim()}`,
				};
			}
		}
		const commit = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
		const tree = (await git(path, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
		return { commit, tree };
	} finally {
		await git(repo, ["worktree", "remove", "--force", path]);
		rmSync(path, { recursive: true, force: true });
	}
}

/**
 * The combined gate record must be a passing verdict on exactly what this landing merges: the same sources
 * at the same commits, on the target tip it was built on. A landing that resumes after some sources landed
 * accepts only the tip its own last landing left (`resumedTip`, recorded as that source landed), so a commit
 * from anywhere else can never slip in between, and checks the sources still to land. Returns the tip the
 * landing must start from; every merge after it is made on the tip the one before produced.
 */
async function assertIntegrated(
	run: FactoryRun,
	repo: string,
	land: { integration: string; target: string },
	shas: Record<string, string>,
	resumed: boolean,
	resumedTip: string | undefined,
): Promise<string> {
	const retry = `retry the ${land.integration} node`;
	const record = run.readIntegrationRecord(land.integration);
	if (!record)
		throw new Error(
			`The combined change has no gate record yet; run the ${land.integration} node.`,
		);
	if (!record.ok)
		throw new Error(
			`The combined change did not pass its gates${record.reason ? ` (${record.reason})` : ""}; fix the cause, then ${retry}.`,
		);
	const recorded = record.sources;
	const covered = resumed
		? Object.entries(shas).every(([node, sha]) => recorded[node] === sha)
		: Object.keys(recorded).length === Object.keys(shas).length &&
			Object.entries(shas).every(([node, sha]) => recorded[node] === sha);
	if (!covered)
		throw new Error(
			`The combined gate run does not cover what would land now (a source changed or was added since); ${retry}.`,
		);
	const tip = (
		await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${land.target}^{commit}`])
	).stdout.trim();
	// Nothing landed yet, or only sources with nothing to merge: the target must still be where the gates
	// built the combined change. Otherwise it must be exactly where this release's last landing left it.
	const expected = resumed && resumedTip ? resumedTip : record.targetTip;
	if (!expected || !tip || tip !== expected)
		throw new Error(
			resumedTip && resumed
				? `${land.target} moved after this release's last landing; it must return to ${resumedTip} (the tip that landing left) before the landing can continue, then ${retry}.`
				: `${land.target} moved since the combined gate run; ${retry}.`,
		);
	// This release's landings were made on the tip the gates tested: that tip must be behind where they left it.
	if (
		expected !== record.targetTip &&
		(await git(repo, ["merge-base", "--is-ancestor", record.targetTip, expected])).code !== 0
	)
		throw new Error(`${land.target} moved since the combined gate run; ${retry}.`);
	return tip;
}

/**
 * Brings the person's checkout along for a target update that completed without its sync (the host stopped
 * between the ref update and the sync): only when HEAD is on the target, and with the same refusal to
 * overwrite as the normal sync. Staged changes to other files are kept.
 */
async function resyncCheckout(
	repo: string,
	target: string,
	move: { from: string; to: string },
	hooks?: { insideCheckoutLock?: () => Promise<void>; beforeIndexInstall?: () => Promise<void> },
): Promise<void> {
	const ref = `refs/heads/${target}`;
	await withIndexLock(
		repo,
		async (index, holdUntilInstalled) => {
			// HEAD is locked too, like in a normal landing and through the installation of the index: a branch
			// switch must write HEAD under that lock, so one that already finished is seen by the check below
			// and one still in flight fails instead of landing between the check and the installation.
			holdUntilInstalled(await acquireHeadLock(repo, target, move));
			const env = { GIT_INDEX_FILE: index };
			const head = (await git(repo, ["symbolic-ref", "-q", "HEAD"])).stdout.trim();
			if (head !== ref) return false;
			await hooks?.insideCheckoutLock?.();
			// No check of the index against the old tip: a two-way read-tree keeps staged changes to files the
			// landing does not touch, accepts an index that already holds the landed commit, and refuses (below)
			// rather than overwrite anything the person changed in a landed file.
			const synced = await git(repo, ["read-tree", "-m", "-u", move.from, move.to], env);
			if (synced.code !== 0)
				throw new Error(
					`Landed on ${target} (${move.from} -> ${move.to}), but your checkout could not be brought along: ${(synced.stderr || synced.stdout).trim()}. Move the files it names aside, then run "git read-tree -m -u ${move.from} ${move.to}" in your checkout.`,
				);
			return true;
		},
		hooks?.beforeIndexInstall,
	);
}

/**
 * The snapshot commit to land, validated from one read of the gate record: it passed, it names exactly the
 * worktree's current content (tree), that tree is the snapshot commit's own tree, and the change has clean
 * ownership. The caller lands this commit, so a gate run that replaces the record afterwards cannot change
 * what lands.
 */
export async function gatedSnapshot(run: FactoryRun, meta: WorktreeMeta): Promise<string> {
	const record = run.readGateRecord(meta.nodeId);
	const [tree, { violations }] = await Promise.all([contentTree(meta.path), run.changed(meta)]);
	if (violations.length)
		throw new Error(`${meta.nodeId} violates its ownership: ${violations.join(", ")}`);
	const sha = record?.snapshot;
	if (!record?.ok || record.diffHash !== tree || !sha)
		throw new Error(
			`${meta.nodeId} has no fresh passing gate record; run the gates again after the last change.`,
		);
	if (
		!(await hasCommit(meta.path, sha)) ||
		(await git(meta.path, ["rev-parse", `${sha}^{tree}`])).stdout.trim() !== tree
	)
		throw new Error(`${meta.nodeId} has no gated snapshot of its content; run the gates again.`);
	return sha;
}

interface Pending {
	meta: WorktreeMeta;
	/** No change at all: nothing to commit or merge. */
	empty: boolean;
	/** An uncommitted change to commit (gated again right before the commit). */
	dirty: boolean;
	/** The target tip a landing of this source already produced, when the host stopped before recording it. */
	done?: string;
}

/**
 * Lands every source worktree on the target branch of the main checkout. The caller is the `land`
 * node's tool, but enforcement does not live in the model: the human release is read from the DAG's own
 * state (`releaseApproved`), every uncommitted change needs a fresh passing host gate record and clean
 * ownership (checked in the preflight and again right before its commit), the checkout must be on the
 * target branch with no merge of its own in progress (checked again right before each merge), and the
 * merge names the exact commit the host made, never the branch. A conflict aborts only the merge this
 * landing started. The commit is recorded before its merge, so a retry after a failed merge lands that
 * commit (plus a newly gated correction, if any) instead of mistaking the clean worktree for no change.
 */
export function landFactory(
	run: FactoryRun,
	land: { sources: string[]; release: string; target: string; integration?: string },
	/**
	 * Test seams: after a source's final gate check (before its snapshot is recorded), and right after the
	 * source branch moved onto that snapshot (before the move is recorded as done).
	 */
	hooks?: {
		afterGateCheck?: (nodeId: string) => Promise<void>;
		afterBranchMove?: (nodeId: string) => Promise<void>;
		/** Right after a source's target update, before the checkout sync and before it is recorded. */
		afterRefUpdate?: () => Promise<void>;
		/** Inside the checkout's HEAD lock, before the checkout sync (a normal landing and a recovery alike). */
		insideCheckoutLock?: () => Promise<void>;
		/** After the sync, with the HEAD lock still held, right before the private index is installed. */
		beforeIndexInstall?: () => Promise<void>;
	},
): Promise<LandedSource[]> {
	return run.serial("land", async () => {
		if (!(await run.options.releaseApproved(run.dagId, land.release)))
			throw new Error(
				`Release ${land.release} has no human approval; landing is refused until a person approves it.`,
			);
		const repo = await run.repo();
		await assertTarget(repo, land.target);

		// Preflight everything before touching the target: all-or-nothing up to the merges themselves.
		const pending: Pending[] = [];
		const shas: Record<string, string> = {};
		for (const nodeId of land.sources) {
			let meta = run.readMeta(nodeId);
			if (!meta) throw new Error(`Node ${nodeId} has no worktree to land`);
			if (meta.landed) continue;
			run.activeWorktree(nodeId);
			const head = (await git(meta.path, ["rev-parse", "HEAD"])).stdout.trim();
			// A landing that stopped while recording its gated commit left the intent behind: finish it when
			// the move happened, forget it when it did not, and refuse anything else.
			if (meta.recording) {
				const { from, to } = meta.recording;
				const { recording: _done, ...rest } = meta;
				if (head === to) meta = { ...rest, committed: to };
				else if (head === from) meta = rest;
				else
					throw new Error(
						`${nodeId} moved while its landing was recording a commit; retry the coder and run the gates again.`,
					);
				run.writeMeta(meta);
			}
			// A landing that stopped around its target update left the move it was about to make: the target at
			// its end means the update completed and only the record was lost; at its start, that it never ran.
			if (meta.landing) {
				const now = (
					await git(repo, ["rev-parse", "--verify", "-q", `refs/heads/${land.target}^{commit}`])
				).stdout.trim();
				if (now === meta.landing.to) {
					pending.push({ meta, empty: false, dirty: false, done: now });
					continue;
				}
				if (now !== meta.landing.from)
					throw new Error(
						`${land.target} moved while ${nodeId} was landing; check what landed, then retry the integration node.`,
					);
				const { landing: _unfinished, ...rest } = meta;
				meta = rest;
				run.writeMeta(meta);
			}
			// Same notion of a change as the gates (dependency links are never content).
			const dirty = (await run.changed(meta)).files.length > 0;
			if (meta.committed && head !== meta.committed)
				throw new Error(
					`${nodeId} moved after its landing commit; retry the coder and run the gates again.`,
				);
			if (!meta.committed) {
				// Workers cannot commit; a branch ahead of its fork point without a host commit is not ours.
				const ahead = (
					await git(meta.path, ["rev-list", "--count", `${meta.base}..HEAD`])
				).stdout.trim();
				if (ahead !== "" && ahead !== "0")
					throw new Error(`${nodeId} has commits the factory did not make; refusing to land it.`);
			}
			const sha = dirty ? await gatedSnapshot(run, meta) : meta.committed;
			if (sha) shas[nodeId] = sha;
			pending.push({ meta, empty: !dirty && !meta.committed, dirty });
		}
		// The tip this release's own landings left, in landing order, and whether any landing already ran.
		let resumedTip: string | undefined;
		let resumed = false;
		for (const nodeId of land.sources) {
			const stored = run.readMeta(nodeId);
			if (stored?.landed) {
				resumed = true;
				if (stored.landedTip) resumedTip = stored.landedTip;
			}
			const finished = pending.find((p) => p.meta.nodeId === nodeId)?.done;
			if (finished) {
				resumed = true;
				resumedTip = finished;
			}
		}
		// Each merge below is made on the tip the one before produced (the first on the gate-tested tip), so
		// the compare-and-swap of the ref protects exactly what was tested.
		let expected = land.integration
			? await assertIntegrated(
					run,
					repo,
					{ integration: land.integration, target: land.target },
					shas,
					resumed,
					resumedTip,
				)
			: undefined;

		const checkoutHooks = {
			...(hooks?.afterRefUpdate ? { afterRefUpdate: hooks.afterRefUpdate } : {}),
			...(hooks?.insideCheckoutLock ? { insideCheckoutLock: hooks.insideCheckoutLock } : {}),
			...(hooks?.beforeIndexInstall ? { beforeIndexInstall: hooks.beforeIndexInstall } : {}),
		};
		const landed: LandedSource[] = land.sources
			.filter((nodeId) => run.readMeta(nodeId)?.landed)
			.map((node) => ({ node, status: "already-landed" as const }));
		for (const { meta: planned, empty, dirty, done } of pending) {
			let meta = planned;
			let commit: string | undefined;
			if (done && planned.landing) {
				// The target update completed before the host recorded it: only the checkout sync may be missing.
				await resyncCheckout(repo, land.target, planned.landing, checkoutHooks);
				commit = done;
				if (land.integration) expected = done;
			} else if (!empty) {
				if (dirty) {
					// Land exactly the snapshot the gates tested: re-check that the record is fresh (the worktree
					// still holds that content) and sits on the worktree's HEAD, then move the branch onto it.
					const sha = await gatedSnapshot(run, meta);
					// The combined gates validated one snapshot per source; a gate run since then must not swap it.
					if (land.integration && sha !== shas[meta.nodeId])
						throw new Error(
							`${meta.nodeId} was gated again after the combined gate run; retry the ${land.integration} node.`,
						);
					await hooks?.afterGateCheck?.(meta.nodeId);
					const head = (await git(meta.path, ["rev-parse", "HEAD"])).stdout.trim();
					if ((await git(meta.path, ["rev-parse", `${sha}^`])).stdout.trim() !== head)
						throw new Error(
							`${meta.nodeId} has no gated snapshot on its current commit; run the gates again.`,
						);
					// Record the intent first, so a host stop between the move and the record is recoverable.
					run.writeMeta({ ...meta, recording: { from: head, to: sha } });
					if ((await git(meta.path, ["reset", "-q", sha])).code !== 0)
						throw new Error(`Could not record the gated snapshot of ${meta.nodeId}`);
					await hooks?.afterBranchMove?.(meta.nodeId);
					meta = { ...meta, committed: sha };
					run.writeMeta(meta);
				}
				const sha = meta.committed;
				if (!sha) throw new Error(`Nothing to land in ${meta.nodeId}`);
				await assertTarget(repo, land.target);
				commit = await landOnTarget(
					repo,
					run.options.worktreeRoot,
					land.target,
					sha,
					`factory: land ${meta.nodeId}`,
					checkoutHooks,
					{
						...(expected ? { expectedTip: expected } : {}),
						intent: (move) => run.writeMeta({ ...meta, landing: move }),
					},
				);
				if (land.integration) expected = commit;
			}
			const { landing: _settled, ...settled } = meta;
			run.writeMeta({ ...settled, landed: true, ...(commit ? { landedTip: commit } : {}) });
			// Edits made after the final check are not part of what landed; never delete them with the worktree.
			const later = !(await removeLandedWorktree(meta));
			landed.push({
				node: meta.nodeId,
				status: empty ? "unchanged" : "landed",
				...(commit ? { commit } : {}),
				...(later ? { keptWorktree: true as const } : {}),
			});
		}
		return landed;
	});
}

export function registerLandTool(pi: ExtensionAPI, run: FactoryRun): void {
	pi.registerTool({
		name: FACTORY_TOOL.land,
		label: "Land factory work",
		description:
			"Land the approved work on the target branch. Only works after a human approved the release; the host refuses otherwise. Takes no arguments.",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.land);
			if (bound.node.role !== "land") throw new Error("Only the land node may land");
			return toolResult({ landed: await landFactory(run, bound.node) });
		},
	});
}
