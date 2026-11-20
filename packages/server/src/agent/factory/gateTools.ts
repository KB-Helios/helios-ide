import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectGates, runGates } from "pi-swarm";
import { Type } from "typebox";
import { boundFor, sourcesOf, sourceWorktree, toolResult } from "./access";
import { clip, type FactoryRun, type GateRecord, type WorktreeMeta } from "./run";
import { defaultGateSandbox, withGateSandbox } from "./sandbox";
import {
	blobAt,
	contentTree,
	inSnapshotCheckout,
	snapshotCommit,
	snapshotFiles,
	treeFiles,
	treeStat,
	workingBlob,
} from "./snapshot";
import { FACTORY_TOOL, isProtectedBasename, PROTECTED_BASENAMES } from "./spec";

const GATE_TIMEOUT_MS = 15 * 60_000;
/** The refusal for a worktree that changed a build/gate definition; the coder can fix it by reverting. */
export const CHANGED_DEFINITIONS = "Gates do not run over changed build or gate definitions";

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
				const sandbox = run.options.sandbox ?? defaultGateSandbox();
				const available = await sandbox.availability();
				if (!available.ok) {
					// Fail closed: gate code never runs unconfined, and the record says why nothing ran.
					record = refuse(available.reason);
				} else {
					const gateRoot =
						sandbox.checkoutRoot?.(run.options.worktreeRoot) ?? run.options.worktreeRoot;
					const { results, unavailable } = await inSnapshotCheckout(
						repo,
						gateRoot,
						snap.commit,
						(checkout) =>
							withGateSandbox(
								sandbox,
								{ checkout, commands, scratchRoot: join(gateRoot, ".gate-scratch") },
								async (gates) => ({
									results: await runGates(commands, checkout, {
										timeoutMs: GATE_TIMEOUT_MS,
										runner: gates.runner,
										...(signal ? { signal } : {}),
									}),
									unavailable: gates.unavailable(),
								}),
							),
					);
					// A cancelled run says nothing about quality: never record it, so the next call runs the gates.
					if (signal?.aborted) throw signal.reason ?? new Error("The gate run was cancelled");
					if (unavailable) {
						// The sandbox could not be set up for this run, so the command never executed.
						record = refuse(`The gate sandbox could not be set up: ${unavailable}`);
					} else {
						const passed =
							results.length === commands.length && results.every((result) => result.ok);
						record = { ok: passed, commands, results, ...base };
					}
				}
			}
		}
		run.writeGateRecord(meta.nodeId, record);
		return record;
	});
}

/**
 * Root build/gate definitions that differ between the trusted checkout (where the gate commands are
 * detected) and the snapshot (where they run). Compared by blob id, so only real content differences count.
 */
async function definitionDrift(repo: string, worktree: string, commit: string): Promise<string[]> {
	const drifted: string[] = [];
	for (const name of PROTECTED_BASENAMES) {
		const [checkout, snapshot] = await Promise.all([
			workingBlob(repo, name),
			blobAt(worktree, commit, name),
		]);
		if (checkout !== snapshot) drifted.push(name);
	}
	return drifted;
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
			"The host's own report on your source worktrees: changed files, diff stat, ownership violations and the latest recorded gate verdict (and whether it is still fresh).",
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
			return toolResult({ sources });
		},
	});
}
