import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { removeWorktree, runCommand } from "pi-swarm";
import { Type } from "typebox";
import { boundFor, toolResult } from "./access";
import { sourceStatus } from "./gateTools";
import type { FactoryRun, WorktreeMeta } from "./run";
import { hasCommit } from "./snapshot";
import { FACTORY_TOOL } from "./spec";

export interface LandedSource {
	node: string;
	status: "landed" | "unchanged" | "already-landed";
	commit?: string;
}

const IDENTITY = ["-c", "user.name=ThinkRail", "-c", "user.email=agents@thinkrail.invalid"];

async function git(cwd: string, args: string[]) {
	return runCommand("git", args, { cwd });
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
		// A rename or copy carries its original path as the next record.
		if (record[0] === "R" || record[0] === "C") i++;
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
): Promise<string> {
	const ref = `refs/heads/${target}`;
	const resolved = await git(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
	if (resolved.code !== 0) throw new Error(`The target branch ${target} does not exist.`);
	const tip = resolved.stdout.trim();
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

	const onTarget = async () =>
		(await git(repo, ["symbolic-ref", "-q", "HEAD"])).stdout.trim() === ref;
	if (await onTarget()) {
		const landed = new Set(
			(await git(repo, ["diff", "--name-only", "-z", tip, merged])).stdout
				.split("\0")
				.filter(Boolean),
		);
		const local = statusPaths(
			(await git(repo, ["status", "--porcelain", "-z", "--untracked-files=all"])).stdout,
		).filter((file) => landed.has(file));
		if (local.length)
			throw new Error(
				`Your uncommitted changes touch files this landing changes (${local.join(", ")}); commit or stash them first. Nothing was changed.`,
			);
	}
	const updated = await git(repo, ["update-ref", "-m", message, ref, merged, tip]);
	if (updated.code !== 0)
		throw new Error(`${target} moved while landing; nothing was changed. Land again.`);
	if (await onTarget()) {
		const synced = await git(repo, ["read-tree", "-m", "-u", tip, merged]);
		if (synced.code !== 0)
			throw new Error(
				`Landed on ${target}, but your checkout could not be brought along (${(synced.stderr || synced.stdout).trim()}); run "git reset --keep HEAD" there.`,
			);
	}
	return merged;
}

/** The source's uncommitted change must have clean ownership and a fresh passing host gate record. */
async function assertGated(run: FactoryRun, meta: WorktreeMeta): Promise<void> {
	const status = await sourceStatus(run, meta);
	if (status.ownershipViolations.length)
		throw new Error(
			`${meta.nodeId} violates its ownership: ${status.ownershipViolations.join(", ")}`,
		);
	if (!status.gates?.ok || !status.gates.fresh)
		throw new Error(
			`${meta.nodeId} has no fresh passing gate record; run the gates again after the last change.`,
		);
}

interface Pending {
	meta: WorktreeMeta;
	/** No change at all: nothing to commit or merge. */
	empty: boolean;
	/** An uncommitted change to commit (gated again right before the commit). */
	dirty: boolean;
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
	land: { sources: string[]; release: string; target: string },
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
		for (const nodeId of land.sources) {
			const meta = run.readMeta(nodeId);
			if (!meta) throw new Error(`Node ${nodeId} has no worktree to land`);
			if (meta.landed) continue;
			run.activeWorktree(nodeId);
			const head = (await git(meta.path, ["rev-parse", "HEAD"])).stdout.trim();
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
			if (dirty) await assertGated(run, meta);
			pending.push({ meta, empty: !dirty && !meta.committed, dirty });
		}

		const landed: LandedSource[] = land.sources
			.filter((nodeId) => run.readMeta(nodeId)?.landed)
			.map((node) => ({ node, status: "already-landed" as const }));
		for (const { meta: planned, empty, dirty } of pending) {
			let meta = planned;
			let commit: string | undefined;
			if (!empty) {
				if (dirty) {
					// Land exactly the snapshot the gates tested: re-check that the record is fresh (the worktree
					// still holds that content) and sits on the worktree's HEAD, then move the branch onto it.
					await assertGated(run, meta);
					const sha = run.readGateRecord(meta.nodeId)?.snapshot;
					const head = (await git(meta.path, ["rev-parse", "HEAD"])).stdout.trim();
					if (
						!sha ||
						!(await hasCommit(meta.path, sha)) ||
						(await git(meta.path, ["rev-parse", `${sha}^`])).stdout.trim() !== head
					)
						throw new Error(
							`${meta.nodeId} has no gated snapshot on its current commit; run the gates again.`,
						);
					if ((await git(meta.path, ["reset", "-q", sha])).code !== 0)
						throw new Error(`Could not record the gated snapshot of ${meta.nodeId}`);
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
				);
			}
			run.writeMeta({ ...meta, landed: true });
			await removeWorktree(meta, { deleteBranch: true });
			landed.push({
				node: meta.nodeId,
				status: empty ? "unchanged" : "landed",
				...(commit ? { commit } : {}),
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
