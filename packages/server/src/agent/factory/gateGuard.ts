import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHANGED_DEFINITIONS, runFactoryGates } from "./gateTools";
import type { FactoryRun, GateRecord } from "./run";
import { contentTree } from "./snapshot";

const SUBMIT_TOOL = "dag_submit_result";
const REPORT_TAIL = 4000;
const REPORT_MAX = 12_000;

/** The failing gate report a coder gets back: what the host ran, how it ended and the tail of its output. */
export function formatGateFailure(record: GateRecord): string {
	const lines: string[] = [];
	if (record.violations.length) lines.push(`Ownership violations: ${record.violations.join(", ")}`);
	if (record.reason && record.results.length === 0) lines.push(record.reason);
	for (const result of record.results) {
		if (result.ok) {
			lines.push(`PASS ${result.command}`);
			continue;
		}
		lines.push(`FAIL ${result.command} (exit ${result.exitCode})`);
		lines.push(result.outputTail.slice(-REPORT_TAIL));
	}
	const text = lines.join("\n");
	return text.length > REPORT_MAX ? `${text.slice(0, REPORT_MAX)}\n[report cut]` : text;
}

/**
 * Whether a failed record is something the coder can fix by changing its worktree: a failing command or
 * an ownership violation. A record without either (untrusted project, no declared gate) is not, so
 * correcting would only burn the budget; the gate node reports it to the person instead.
 */
export function isFixable(record: GateRecord): boolean {
	return (
		record.violations.length > 0 ||
		record.results.some((result) => !result.ok) ||
		Boolean(record.reason?.startsWith(CHANGED_DEFINITIONS))
	);
}

/**
 * The bounded gate-retry loop of a coder attempt (ai-factory.md, "failed gates"). When a coder tries
 * to submit its result the host runs (or reuses a fresh record of) the project's declared gates in the
 * coder's own worktree. A passing record lets the submit through. A failing one blocks the submit and
 * hands the coder the failing report as the tool's refusal, so it fixes forward in the same worktree and
 * submits again — at most `retries` times per attempt (the template's `retries`, persisted by the host so a
 * restart cannot reset it). Once the budget is spent the submit goes through with the failure on record:
 * the gate node reports it and the person decides at the release. The host only reads the node's own
 * worktree and calls the same gate runner as `factory_run_gates`; nothing here widens what a coder may run.
 */
export function registerGateGuard(pi: ExtensionAPI, run: FactoryRun): void {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== SUBMIT_TOOL) return undefined;
		const sessionId = ctx.sessionManager.getSessionId();
		const bound = run.boundNode(sessionId);
		if (bound?.node.role !== "coder") return undefined;
		const budget = bound.node.retries ?? 0;
		if (budget <= 0) return undefined;
		const used = run.gateRetriesUsed(bound.nodeId, sessionId);
		if (used >= budget) return undefined;

		const meta = run.readMeta(bound.nodeId);
		if (!meta || meta.landed) return undefined;
		let record: GateRecord;
		try {
			const tree = await contentTree(meta.path);
			const saved = run.readGateRecord(bound.nodeId);
			record =
				saved && saved.diffHash === tree ? saved : await runFactoryGates(run, meta, ctx.signal);
		} catch {
			// The host could not judge the worktree: do not hold the coder hostage to its own failure.
			return undefined;
		}
		if (record.ok || !isFixable(record)) return undefined;
		// Parallel submits in one message all passed the first check before the awaits; recheck right
		// before spending, synchronously with the increment, so the budget can never be exceeded.
		if (run.gateRetriesUsed(bound.nodeId, sessionId) >= budget) return undefined;
		const number = run.useGateRetry(bound.nodeId, sessionId);
		return {
			block: true,
			reason: [
				`The project's gates failed, so your result was not submitted (correction ${number} of ${budget}).`,
				formatGateFailure(record),
				`Fix the cause in your worktree, call factory_run_gates until it passes, then submit again. ${
					budget - number > 0
						? `${budget - number} correction(s) remain.`
						: "This was the last correction: the next submit goes through with the failure on record."
				}`,
			].join("\n\n"),
		};
	});
}
