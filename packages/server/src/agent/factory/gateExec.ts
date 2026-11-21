import { join } from "node:path";
import { type GateResult, runGates } from "pi-swarm";
import type { FactoryRun } from "./run";
import { defaultGateSandbox, withGateSandbox } from "./sandbox";
import { blobAt, inSnapshotCheckout, workingBlob } from "./snapshot";
import { PROTECTED_BASENAMES } from "./spec";

const GATE_TIMEOUT_MS = 15 * 60_000;
/** The refusal for a worktree that changed a build/gate definition; the coder can fix it by reverting. */
export const CHANGED_DEFINITIONS = "Gates do not run over changed build or gate definitions";

/**
 * Runs `commands` against `commit` in a throwaway checkout inside the OS sandbox. Fail closed: a missing
 * or unusable sandbox returns a `reason` and nothing ran. A cancelled run throws, so it is never recorded.
 */
export async function executeGates(
	run: FactoryRun,
	repo: string,
	commit: string,
	commands: string[],
	signal?: AbortSignal,
): Promise<{ ok: boolean; results: GateResult[]; reason?: string }> {
	const sandbox = run.options.sandbox ?? defaultGateSandbox();
	const available = await sandbox.availability();
	if (!available.ok) return { ok: false, results: [], reason: available.reason };
	const gateRoot = sandbox.checkoutRoot?.(run.options.worktreeRoot) ?? run.options.worktreeRoot;
	const { results, unavailable } = await inSnapshotCheckout(repo, gateRoot, commit, (checkout) =>
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
	if (signal?.aborted) throw signal.reason ?? new Error("The gate run was cancelled");
	if (unavailable)
		return {
			ok: false,
			results: [],
			reason: `The gate sandbox could not be set up: ${unavailable}`,
		};
	return {
		ok: results.length === commands.length && results.every((result) => result.ok),
		results,
	};
}

/**
 * Root build/gate definitions that differ between the trusted checkout (where the gate commands are
 * detected) and the commit they run in. Compared by blob id, so only real content differences count.
 */
export async function definitionDrift(
	repo: string,
	worktree: string,
	commit: string,
): Promise<string[]> {
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
