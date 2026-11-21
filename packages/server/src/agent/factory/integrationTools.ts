import { basename } from "node:path";
import { detectGates, runCommand } from "pi-swarm";
import { CHANGED_DEFINITIONS, definitionDrift, executeGates } from "./gateExec";
import { combineCommits, landableCommit } from "./landTools";
import type { FactoryRun, IntegrationRecord } from "./run";
import { treeFiles } from "./snapshot";
import { isProtectedBasename } from "./spec";

/**
 * The commit landing would merge for each source that still has something to land, in source order. A
 * source that already landed is part of the target; an empty one has nothing to merge. Throws, with a plain
 * reason, for a source without a worktree or without a fresh passing gate record.
 */
export async function landableSources(
	run: FactoryRun,
	sources: readonly string[],
): Promise<Record<string, string>> {
	const shas: Record<string, string> = {};
	for (const nodeId of sources) {
		if (run.readMeta(nodeId)?.landed) continue;
		const sha = await landableCommit(run, run.activeWorktree(nodeId));
		if (sha) shas[nodeId] = sha;
	}
	return shas;
}

/**
 * Runs the project's declared gates on the combined change: the target's tip with every source's landable
 * commit merged in, built in a throwaway detached checkout (the person's checkout is never touched) and
 * gated in the same OS sandbox as a single coder's snapshot. Fails closed with a plain reason when a source
 * has no fresh passing gate record, a merge conflicts, the project is untrusted or declares no gates, the
 * combined change alters a build/gate definition, the checkout's definitions drifted, or no sandbox is
 * available; none of those runs anything. The host-written record is what landing checks. A cancelled run is
 * never recorded.
 */
export function runIntegrationGates(
	run: FactoryRun,
	nodeId: string,
	integration: { sources: string[]; target: string },
	signal?: AbortSignal,
): Promise<IntegrationRecord> {
	return run.serial(`integration:${nodeId}`, async () => {
		const repo = await run.repo();
		const resolved = await runCommand(
			"git",
			["rev-parse", "--verify", "-q", `refs/heads/${integration.target}^{commit}`],
			{ cwd: repo },
		);
		const targetTip = resolved.code === 0 ? resolved.stdout.trim() : "";
		let sources: Record<string, string> = {};
		const ranAt = new Date().toISOString();
		const verdict = (
			reason: string | undefined,
			rest: Partial<IntegrationRecord> = {},
		): IntegrationRecord => ({
			ok: false,
			...(reason ? { reason } : {}),
			commands: [],
			results: [],
			targetTip,
			sources,
			combined: "",
			tree: "",
			ranAt,
			...rest,
		});
		const retry = `retry the ${nodeId} node`;

		let record: IntegrationRecord;
		if (!targetTip) {
			record = verdict(`The target branch ${integration.target} does not exist.`);
		} else if (!run.options.isTrusted()) {
			record = verdict("The project is not trusted, so its gates are not run.");
		} else {
			let problem: string | undefined;
			try {
				sources = await landableSources(run, integration.sources);
			} catch (error) {
				problem = `${error instanceof Error ? error.message : String(error)} Once it is fixed, ${retry}.`;
			}
			if (problem) {
				record = verdict(problem);
			} else if (Object.keys(sources).length === 0) {
				const tree = (
					await runCommand("git", ["rev-parse", `${targetTip}^{tree}`], { cwd: repo })
				).stdout.trim();
				record = verdict(undefined, { ok: true, combined: targetTip, tree });
			} else {
				const commands = detectGates(repo);
				if (commands.length === 0) {
					record = verdict("The project declares no quality gates (typecheck, lint or test).");
				} else {
					const built = await combineCommits(
						repo,
						run.options.worktreeRoot,
						targetTip,
						Object.entries(sources).map(([node, sha]) => ({ node, sha })),
					);
					if ("conflict" in built) {
						record = verdict(built.conflict);
					} else {
						const combined = { combined: built.commit, tree: built.tree };
						const files = await treeFiles(repo, targetTip, built.tree);
						const definitions = files.filter((file) => isProtectedBasename(basename(file)));
						const drifted = definitions.length
							? []
							: await definitionDrift(repo, repo, built.commit);
						if (definitions.length) {
							record = verdict(`${CHANGED_DEFINITIONS}: ${definitions.join(", ")}`, combined);
						} else if (drifted.length) {
							record = verdict(
								`The checkout's gate definitions differ from the combined change (${drifted.join(", ")}); settle them in the checkout, then ${retry}.`,
								combined,
							);
						} else {
							const executed = await executeGates(run, repo, built.commit, commands, signal);
							record = executed.reason
								? verdict(executed.reason, combined)
								: verdict(undefined, {
										...combined,
										ok: executed.ok,
										commands,
										results: executed.results,
									});
						}
					}
				}
			}
		}
		run.writeIntegrationRecord(nodeId, record);
		return record;
	});
}

/** What the host's report says about the combined gate record: its verdict and whether it still covers the sources. */
export async function integrationStatus(run: FactoryRun, nodeId: string, sources: string[]) {
	const record = run.readIntegrationRecord(nodeId);
	if (!record) return { node: nodeId, record: null };
	const current = await landableSources(run, sources).catch(() => undefined);
	const fresh =
		current !== undefined &&
		Object.keys(current).length === Object.keys(record.sources).length &&
		Object.entries(current).every(([node, sha]) => record.sources[node] === sha);
	return {
		node: nodeId,
		ok: record.ok,
		fresh,
		ranAt: record.ranAt,
		reason: record.reason ?? null,
		targetTip: record.targetTip,
		sources: record.sources,
		commands: record.commands,
		results: record.results.map((result) => ({
			command: result.command,
			ok: result.ok,
			exitCode: result.exitCode,
			outputTail: result.ok ? "" : result.outputTail,
		})),
	};
}
