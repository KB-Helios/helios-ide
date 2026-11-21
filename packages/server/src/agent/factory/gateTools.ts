import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectGates } from "pi-swarm";
import { Type } from "typebox";
import { boundFor, integrationOf, sourcesOf, sourceWorktree, toolResult } from "./access";
import { CHANGED_DEFINITIONS, definitionDrift, executeGates } from "./gateExec";
import { integrationStatus, runIntegrationGates } from "./integrationTools";
import { clip, type FactoryRun, type GateRecord, type WorktreeMeta } from "./run";
import { contentTree, snapshotCommit, snapshotFiles, treeFiles, treeStat } from "./snapshot";
import { FACTORY_TOOL, isProtectedBasename } from "./spec";

/**
 * Runs the project's declared gates in one worktree and records the verdict on the host. The commands
 * come from `detectGates` (the repository's own typecheck/lint/test scripts), never from the model.
 * Nothing runs when the project is untrusted, when no gate is declared, or while the diff violates the
 * node's ownership (that also covers a poisoned manifest, since manifests are protected paths). Gate
 * processes run inside the OS sandbox (`sandbox.ts`) and nowhere else: without one, nothing runs.
 */
export function runFactoryGates(
	run: FactoryRun,
	meta: WorktreeMeta,
	signal?: AbortSignal,
): Promise<GateRecord> {
	return run.serial(`gates:${meta.nodeId}`, async () => {
		// The gates test an immutable snapshot of the worktree, never the live files: the record names the
		// snapshot's tree, so it is fresh exactly when the worktree still holds that content, and landing
		// merges that very commit. Ownership and definitions are judged on the snapshot's own changes.
		const snap = await snapshotCommit(meta.path, `factory: ${meta.nodeId}`);
		const files = await snapshotFiles(meta.path, snap.commit);
		const violations = run.violations(meta, files);
		// The commands are detected in the trusted checkout; a changed manifest in the snapshot could still
		// swap what a gate runs, so gates never run over changed gate/build definitions, even owned ones.
		const definitions = files.filter((file) => isProtectedBasename(basename(file)));
		const base = {
			violations,
			diffHash: snap.tree,
			snapshot: snap.commit,
			ranAt: new Date().toISOString(),
		};
		const refuse = (reason: string): GateRecord => ({
			ok: false,
			reason,
			commands: [],
			results: [],
			...base,
		});
		let record: GateRecord;
		if (!run.options.isTrusted()) {
			record = refuse("The project is not trusted, so its gates are not run.");
		} else if (violations.length) {
			record = refuse(`Ownership violations: ${violations.join(", ")}`);
		} else if (definitions.length) {
			record = refuse(`${CHANGED_DEFINITIONS}: ${definitions.join(", ")}`);
		} else {
			// Detected in the repository checkout, not the worktree: the model decides neither which
			// scripts exist nor what they are called.
			const repo = await run.repo();
			const commands = detectGates(repo);
			const drifted = await definitionDrift(repo, meta.path, snap.commit);
			if (commands.length === 0) {
				record = refuse("The project declares no quality gates (typecheck, lint or test).");
			} else if (drifted.length) {
				// The commands come from the checkout but run in the snapshot: they must mean the same there.
				record = refuse(
					`The checkout's gate definitions changed since this worktree was made (${drifted.join(", ")}); the worktree needs a fresh base before its gates can run.`,
				);
			} else {
				const executed = await executeGates(run, repo, snap.commit, commands, signal);
				record = executed.reason
					? refuse(executed.reason)
					: { ok: executed.ok, commands, results: executed.results, ...base };
			}
		}
		run.writeGateRecord(meta.nodeId, record);
		return record;
	});
}

/** The host's verdict on one worktree: ownership, a fresh passing gate record, nothing stale. */
export async function sourceStatus(run: FactoryRun, meta: WorktreeMeta) {
	// One captured tree is the source of the change list, the ownership verdict, the stat and freshness,
	// so an edit between separate reads can never pair one change list with another tree's gate result.
	const tree = await contentTree(meta.path);
	const [files, stat] = await Promise.all([
		treeFiles(meta.path, "HEAD", tree),
		treeStat(meta.path, "HEAD", tree),
	]);
	const violations = run.violations(meta, files);
	const record = run.readGateRecord(meta.nodeId);
	const fresh = record?.diffHash === tree;
	return {
		node: meta.nodeId,
		branch: meta.branch,
		changedFiles: files,
		diffStat: stat,
		ownershipViolations: violations,
		gates: record
			? {
					ok: record.ok,
					fresh,
					ranAt: record.ranAt,
					reason: record.reason ?? null,
					commands: record.commands,
					results: record.results.map((result) => ({
						command: result.command,
						ok: result.ok,
						exitCode: result.exitCode,
						outputTail: result.ok ? "" : result.outputTail,
					})),
				}
			: null,
		ready: Boolean(record?.ok && fresh && violations.length === 0 && files.length > 0),
	};
}

export function registerGateTools(pi: ExtensionAPI, run: FactoryRun): void {
	pi.registerTool({
		name: FACTORY_TOOL.diff,
		label: "Worktree diff",
		description:
			"The host's unified diff of your source worktrees against their base (all of them, or one named source). Read-only.",
		parameters: Type.Object({ source: Type.Optional(Type.String()) }),
		async execute(_id, args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.diff);
			const ids = args.source ? [args.source] : sourcesOf(bound);
			const parts: string[] = [];
			for (const nodeId of ids) {
				const meta = sourceWorktree(run, bound, nodeId);
				parts.push(`### ${nodeId}\n${(await run.diff(meta)).patch}`);
			}
			return toolResult(clip(parts.join("\n")));
		},
	});

	pi.registerTool({
		name: FACTORY_TOOL.gates,
		label: "Run project gates",
		description:
			"Run the project's own declared quality gates (typecheck, lint, test scripts) in a factory worktree and record the result. Takes no command: it never runs anything the project did not declare. Refused when the project is not trusted.",
		parameters: Type.Object({
			source: Type.Optional(
				Type.String({ description: "Source node id; only needed with several sources." }),
			),
		}),
		async execute(_id, args, signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.gates);
			if (bound.node.role === "integration") {
				const record = await runIntegrationGates(run, bound.nodeId, bound.node, signal);
				return toolResult({
					node: bound.nodeId,
					ok: record.ok,
					reason: record.reason ?? null,
					targetTip: record.targetTip,
					sources: record.sources,
					results: record.results.map((result) => ({
						command: result.command,
						ok: result.ok,
						exitCode: result.exitCode,
						outputTail: result.ok ? "" : result.outputTail,
					})),
				});
			}
			const meta = sourceWorktree(run, bound, args.source);
			const record = await runFactoryGates(run, meta, signal);
			return toolResult({
				node: meta.nodeId,
				ok: record.ok,
				reason: record.reason ?? null,
				violations: record.violations,
				results: record.results.map((result) => ({
					command: result.command,
					ok: result.ok,
					exitCode: result.exitCode,
					outputTail: result.ok ? "" : result.outputTail,
				})),
			});
		},
	});

	pi.registerTool({
		name: FACTORY_TOOL.report,
		label: "Worktree report",
		description:
			"The host's own report on your source worktrees: changed files, diff stat, ownership violations and the latest recorded gate verdict (and whether it is still fresh). Nodes tied to an integration node also get the combined change's gate verdict.",
		parameters: Type.Object({}),
		async execute(_id, _args, _signal, _update, ctx) {
			const bound = boundFor(run, ctx, FACTORY_TOOL.report);
			const sources = await Promise.all(
				sourcesOf(bound).map(async (nodeId) => {
					const meta = run.readMeta(nodeId);
					if (!meta) return { node: nodeId, missing: true };
					if (meta.landed) return { node: nodeId, landed: true };
					return sourceStatus(run, run.activeWorktree(nodeId));
				}),
			);
			const integration = integrationOf(bound);
			return toolResult({
				sources,
				...(integration
					? { integration: await integrationStatus(run, integration, sourcesOf(bound)) }
					: {}),
			});
		},
	});
}
