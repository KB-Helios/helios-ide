import { expect, test } from "bun:test";
import {
	bySeverity,
	dependsOn,
	needsAttention,
	orderNodes,
	pendingTotal,
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
