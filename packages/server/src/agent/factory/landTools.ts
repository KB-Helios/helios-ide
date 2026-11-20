import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitWorktree, removeWorktree, runCommand } from "pi-swarm";
import { Type } from "typebox";
import { boundFor, toolResult } from "./access";
import { sourceStatus } from "./gateTools";
import type { FactoryRun, WorktreeMeta } from "./run";
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

/**
 * Lands every source worktree on the target branch of the main checkout. The caller is the `land`
 * node's tool, but enforcement does not live in the model: the human release is read from the DAG's own
 * state (`releaseApproved`), every source needs a fresh passing host gate record and clean ownership,
 * and the checkout must be on the target branch. Only then is each worktree committed on its branch,
 * merged (`--no-ff`; a conflict is aborted so the checkout is never left half-merged) and removed.
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
		const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
		if (branch !== land.target)
			throw new Error(
				`The checkout is on ${branch || "a detached HEAD"}, not the target ${land.target}.`,
			);

		// Preflight everything before touching the target: all-or-nothing up to the merges themselves.
		const pending: { meta: WorktreeMeta; empty: boolean }[] = [];
		for (const nodeId of land.sources) {
			const meta = run.readMeta(nodeId);
			if (!meta) throw new Error(`Node ${nodeId} has no worktree to land`);
			if (meta.landed) continue;
			run.activeWorktree(nodeId);
			if (meta.committed) {
				// A previous landing committed this source and its merge failed. The gates passed on exactly
				// this content, so land that commit only if nothing moved since: the branch still points at
				// it and the worktree has no further edits.
				const head = (await git(meta.path, ["rev-parse", "HEAD"])).stdout.trim();
				const dirty = (await git(meta.path, ["status", "--porcelain"])).stdout.trim();
				if (head !== meta.committed || dirty)
					throw new Error(
						`${nodeId} changed after its landing commit; retry the coder and run the gates again.`,
					);
				pending.push({ meta, empty: false });
				continue;
			}
			const status = await sourceStatus(run, meta);
			if (status.ownershipViolations.length)
				throw new Error(
					`${nodeId} violates its ownership: ${status.ownershipViolations.join(", ")}`,
				);
			if (status.changedFiles.length === 0) {
				pending.push({ meta, empty: true });
				continue;
			}
			if (!status.gates?.ok || !status.gates.fresh)
				throw new Error(
					`${nodeId} has no fresh passing gate record; run the gates again after the last change.`,
				);
			pending.push({ meta, empty: false });
		}

		const landed: LandedSource[] = land.sources
			.filter((nodeId) => run.readMeta(nodeId)?.landed)
			.map((node) => ({ node, status: "already-landed" as const }));
		for (const { meta, empty } of pending) {
			let commit: string | undefined;
			if (!empty) {
				const sha = meta.committed ?? (await commitWorktree(meta.path, `factory: ${meta.nodeId}`));
				if (!sha) throw new Error(`Nothing to commit in ${meta.nodeId}`);
				if (!meta.committed) run.writeMeta({ ...meta, committed: sha });
				const merged = await git(repo, [
					...(await mergeIdentity(repo)),
					"merge",
					"--no-ff",
					"-m",
					`factory: land ${meta.nodeId}`,
					meta.branch,
				]);
				if (merged.code !== 0) {
					await git(repo, ["merge", "--abort"]);
					throw new Error(
						`Merging ${meta.nodeId} into ${land.target} failed and was aborted: ${(merged.stderr || merged.stdout).trim()}`,
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
