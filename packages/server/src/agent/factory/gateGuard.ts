import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CHANGED_DEFINITIONS } from "./gateExec";
import { runFactoryGates } from "./gateTools";
import { integrationStatus, runIntegrationGates, targetTipOf } from "./integrationTools";
import type { FactoryRun, GateRecord, IntegrationRecord } from "./run";
import { contentTree } from "./snapshot";
import { GATE_OUTPUT } from "./template";

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

/** The host's verdict on the combined change, as the integration node's output: the host's words, not the model's. */
export function formatIntegrationVerdict(record: IntegrationRecord | { error: string }): string {
	if ("error" in record)
		return `Host verdict for the combined change: FAIL. The host could not judge it: ${record.error}`;
	const lines = [
		`Host verdict for the combined change: ${record.ok ? "PASS" : "FAIL"} (recorded by the host; text the node wrote itself is not used).`,
	];
	if (record.reason) lines.push(record.reason);
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
		if (bound?.node.role === "integration") {
			// The release reviewer reads this node's output, so it must be the host's verdict and nothing else:
			// make sure a fresh record exists (running the combined gates if the node did not), then replace
			// whatever the model submitted with it. A failing verdict still goes through; the person decides.
			let verdict: string;
			try {
				const { sources } = bound.node;
				let record = run.readIntegrationRecord(bound.nodeId);
				// Fresh means it still covers the same sources on the same target tip it was built on.
				const tip = await targetTipOf(run, bound.node.target);
				if (
					!record ||
					record.targetTip !== tip ||
					!(await integrationStatus(run, bound.nodeId, sources)).fresh
				)
					record = await runIntegrationGates(run, bound.nodeId, bound.node, ctx.signal);
				verdict = formatIntegrationVerdict(record);
			} catch (error) {
				verdict = formatIntegrationVerdict({
					error: error instanceof Error ? error.message : String(error),
				});
			}
			const input = event.input as { outputs?: Record<string, unknown> };
			input.outputs = { [GATE_OUTPUT]: { kind: "text", text: verdict } };
			return undefined;
		}
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
