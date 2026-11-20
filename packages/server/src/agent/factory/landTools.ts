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

/**
 * Aborts a failed merge only when it is provably this landing's: `MERGE_HEAD` names exactly the commit the
 * landing merged. A merge someone started between the target check and the factory merge names another
 * commit and is left untouched; so is anything that cannot be read.
 */
export async function abortOwnMerge(repo: string, sha: string): Promise<string> {
	const head = await git(repo, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
	if (head.code !== 0) return "nothing to abort";
	if (head.stdout.trim() !== sha)
		return "a merge the factory did not start is in progress; it was left untouched";
	return (await git(repo, ["merge", "--abort"])).code === 0
		? "aborted"
		: "the abort failed; resolve the checkout by hand";
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
				const merged = await git(repo, [
					...(await mergeIdentity(repo)),
					"merge",
					"--no-ff",
					"-m",
					`factory: land ${meta.nodeId}`,
					sha,
				]);
				if (merged.code !== 0) {
					const aborted = await abortOwnMerge(repo, sha);
					throw new Error(
						`Merging ${meta.nodeId} into ${land.target} failed (${aborted}): ${(merged.stderr || merged.stdout).trim()}`,
					);
				}
				commit = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
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
