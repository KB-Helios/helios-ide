import { expect, test } from "bun:test";
import {
	bySeverity,
	dagActions,
	dependsOn,
	historyTarget,
	needsAttention,
	nodeActions,
	nodeCommand,
	orderNodes,
	pendingTotal,
	queueLine,
	totalUsage,
} from "./factoryModel";

test("dependencies are the distinct sources of a node's incoming edges", () => {
	const edges = [
		{ from: "a", to: "c" },
		{ from: "b", to: "c" },
		{ from: "a", to: "c" },
		{ from: "c", to: "d" },
	];
	expect(dependsOn({ edges }, "c")).toEqual(["a", "b"]);
	expect(dependsOn({ edges }, "a")).toEqual([]);
});

test("nodes waiting on a person come first and keep their order", () => {
	const nodes = [
		{ id: "a", status: "completed" as const },
		{ id: "b", status: "waiting-approval" as const },
		{ id: "c", status: "running" as const },
		{ id: "d", status: "needs-attention" as const },
	];
	expect(orderNodes(nodes).map((node) => node.id)).toEqual(["b", "d", "a", "c"]);
	expect(needsAttention("running")).toBe(false);
	expect(needsAttention("stale")).toBe(true);
});

test("pending gates are summed across DAGs", () => {
	expect(pendingTotal([{ pendingGates: 1 }, { pendingGates: 2 }, { pendingGates: 0 }])).toBe(3);
});

test("usage is summed over the nodes that ran, and absent when none did", () => {
	const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 1 };
	expect(totalUsage([{}, {}])).toBeNull();
	expect(totalUsage([{ usage }, {}, { usage: { ...usage, input: 1, cost: 0.25 } }])).toEqual({
		input: 11,
		output: 10,
		cost: 0.75,
	});
});

test("findings are listed most serious first and the input is untouched", () => {
	const findings = [
		{ severity: "low" as const },
		{ severity: "critical" as const },
		{ severity: "info" as const },
		{ severity: "high" as const },
	];
	expect(bySeverity(findings).map((finding) => finding.severity)).toEqual([
		"critical",
		"high",
		"low",
		"info",
	]);
	expect(findings[0]?.severity).toBe("low");
});

test("the queue line is absent while idle and flags a saturated cap", () => {
	expect(queueLine(null)).toBeNull();
	expect(queueLine({ limit: 4, running: 0, queued: 0 })).toBeNull();
	expect(queueLine({ limit: 4, running: 2, queued: 0 })).toEqual({
		running: 2,
		queued: 0,
		limit: 4,
		saturated: false,
	});
	expect(queueLine({ limit: 2, running: 2, queued: 3 })).toEqual({
		running: 2,
		queued: 3,
		limit: 2,
		saturated: true,
	});
	// A lowered cap with more turns still running than the new limit is not "waiting for a slot" unless work waits.
	expect(queueLine({ limit: 1, running: 3, queued: 0 })?.saturated).toBe(false);
});

test("a node offers only the controls pi-dag accepts for its state", () => {
	expect(nodeActions({ status: "pending" })).toEqual([]);
	expect(nodeActions({ status: "running", attempt: 1, activation: 1 })).toEqual(["cancel"]);
	expect(nodeActions({ status: "queued", attempt: 2, activation: 1 })).toEqual(["cancel"]);
	expect(nodeActions({ status: "interrupted", attempt: 1, activation: 2 })).toEqual([
		"continue",
		"retry",
		"cancel",
	]);
	expect(nodeActions({ status: "interrupted", attempt: 1 })).toEqual(["retry", "cancel"]);
	expect(nodeActions({ status: "cancelled", attempt: 1, activation: 1 })).toEqual(["retry"]);
	expect(nodeActions({ status: "needs-attention", attempt: 3, activation: 1 })).toEqual(["retry"]);
	expect(nodeActions({ status: "completed", attempt: 1, activation: 1 })).toEqual([]);
	expect(nodeActions({ status: "waiting-approval", attempt: 1, activation: 1 })).toEqual([]);
});

test("a node action becomes the exact whitelisted wire command", () => {
	const node = { id: "coder-a", attempt: 2, activation: 3 };
	expect(nodeCommand("retry", node)).toEqual({ kind: "retry", nodeId: "coder-a", attempt: 2 });
	expect(nodeCommand("cancel", node)).toEqual({ kind: "cancel", nodeId: "coder-a" });
	expect(nodeCommand("continue", node)).toEqual({
		kind: "continue",
		nodeId: "coder-a",
		attempt: 2,
		activation: 3,
	});
	expect(nodeCommand("continue", { id: "x", attempt: 1 })).toBeNull();
	expect(nodeCommand("retry", { id: "x" })).toBeNull();
});

test("DAG-wide interrupt needs a running DAG and nothing applies once it is disposed", () => {
	expect(dagActions({ mode: "running", lifecycle: "active" })).toEqual(["interrupt", "cancel"]);
	expect(dagActions({ mode: "paused", lifecycle: "active" })).toEqual(["cancel"]);
	expect(dagActions({ mode: "running", lifecycle: "disposing" })).toEqual([]);
});

test("a history target reads node, attempt and activation", () => {
	expect(historyTarget({ target: { nodeId: "a", attempt: 2, activation: 1 } })).toBe("a #2.1");
	expect(historyTarget({})).toBe("");
});
