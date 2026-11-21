import { expect, test } from "bun:test";
import type { DagReviewView } from "@thinkrail/contracts";
import {
	bySeverity,
	dagActions,
	dependsOn,
	effectiveKey,
	historyTarget,
	needsAttention,
	nodeActions,
	nodeCommand,
	orderNodes,
	pendingTotal,
	planReady,
	queueLine,
	replanReady,
	reviewerSharesFamily,
	reviewForGate,
	type StartForm,
	startBlocker,
	startRequest,
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

const rolesView = (sameFamilyOnly = false) => ({
	models: [
		{ provider: "a", id: "big", name: "Big", family: "alpha", reasoning: true },
		{ provider: "a", id: "small", name: "Small", family: "alpha", reasoning: false },
		{ provider: "b", id: "other", name: "Other", family: "beta", reasoning: true },
	],
	defaults: {
		planner: { provider: "a", id: "big" },
		coder: { provider: "a", id: "big" },
		reviewer: { provider: "b", id: "other" },
		scout: { provider: "a", id: "small" },
	},
	sameFamilyOnly,
});
const form = (patch: Partial<StartForm> = {}): StartForm => ({
	task: "Add the thing",
	mode: "plan",
	picks: {},
	allowSameFamily: false,
	...patch,
});

test("a role left on its default sends no model, and a pick sends exactly that model", () => {
	const view = rolesView();
	expect(startRequest(view, form())).toEqual({ task: "Add the thing" });
	expect(effectiveKey(view, form(), "reviewer")).toBe("b/other");
	expect(startRequest(view, form({ picks: { coder: "a/small", scout: "" } }))).toEqual({
		task: "Add the thing",
		roles: { coder: { provider: "a", id: "small" } },
	});
	// A pick the host does not list is dropped rather than invented.
	expect(startRequest(view, form({ picks: { coder: "z/ghost" } }))).toEqual({
		task: "Add the thing",
	});
});

test("one coder mode sends the task as the single coder; planner mode sends none", () => {
	const view = rolesView();
	expect(startRequest(view, form({ mode: "single", task: "  Fix it  " }))).toEqual({
		task: "Fix it",
		coders: [{ id: "coder", task: "Fix it" }],
	});
	expect(startRequest(view, form({ task: "   " }))).toBeNull();
	expect(startRequest(view, form({ task: "x".repeat(8001) }))).toBeNull();
});

test("a reviewer in the coder's family must be allowed explicitly and is then sent as such", () => {
	const view = rolesView();
	const same = form({ picks: { reviewer: "a/small" } });
	expect(reviewerSharesFamily(view, same)).toBe(true);
	expect(startBlocker(view, same)).toBe("same-family");
	expect(startBlocker(view, form({ ...same, allowSameFamily: true }))).toBeNull();
	expect(startRequest(view, form({ ...same, allowSameFamily: true }))).toMatchObject({
		allowSameFamilyReviewer: true,
	});
	// The switch has no effect when the reviewer is independent.
	expect(startRequest(view, form({ allowSameFamily: true }))).toEqual({ task: "Add the thing" });
	// Moving the coder onto the default reviewer's family re-resolves an automatic reviewer elsewhere.
	expect(reviewerSharesFamily(view, form({ picks: { coder: "b/other" } }))).toBe(false);
	expect(startBlocker(view, form({ picks: { coder: "b/other" } }))).toBeNull();
	// A reviewer picked into the coder's family still shares it.
	expect(
		reviewerSharesFamily(view, form({ picks: { coder: "b/other", reviewer: "b/other" } })),
	).toBe(true);
	expect(reviewerSharesFamily(view, form({ picks: { coder: "b/other", reviewer: "a/big" } }))).toBe(
		false,
	);
	// A host with a single family needs the explicit allowance for the defaults too.
	expect(startBlocker(rolesView(true), form())).toBe("same-family");
	expect(startBlocker(rolesView(true), form({ allowSameFamily: true }))).toBeNull();
});

test("a plan is ready for the factory once its planner completed", () => {
	const node = (status: "running" | "completed", planner?: true) => ({
		id: "planner",
		status,
		held: false,
		task: "",
		...(planner ? { planner } : {}),
	});
	expect(planReady({ nodes: [node("running", true)] })).toBe(false);
	expect(planReady({ nodes: [node("completed", true)] })).toBe(true);
	expect(planReady({ nodes: [node("completed")] })).toBe(false);
});

test("a rejected release or review offers a replan, a rejected plan or an undecided gate does not", () => {
	const node = (id: string, rejected?: true) => ({
		id,
		status: "needs-attention" as const,
		held: false,
		task: "",
		...(rejected ? { rejected } : {}),
	});
	expect(replanReady({ nodes: [node("release", true)] })).toBe(true);
	expect(replanReady({ nodes: [node("review", true), node("release")] })).toBe(true);
	expect(replanReady({ nodes: [node("release"), node("review")] })).toBe(false);
	// A rejected plan is retried in place; only the factory's own steps are sent back to the planner.
	expect(replanReady({ nodes: [node("planner", true)] })).toBe(false);
	expect(replanReady({ nodes: [node("api", true)] })).toBe(false);
});

test("the machine-wide cap shows only when it is full and holds work back", () => {
	const global = (running: number, queued: number) => ({ limit: 3, running, queued });
	expect(
		queueLine({ limit: 4, running: 2, queued: 0, global: global(2, 0) })?.global,
	).toBeUndefined();
	expect(
		queueLine({ limit: 4, running: 1, queued: 0, global: global(3, 0) })?.global,
	).toBeUndefined();
	expect(queueLine({ limit: 4, running: 1, queued: 2, global: global(3, 2) })?.global).toEqual({
		limit: 3,
		running: 3,
		queued: 2,
	});
	// A host without the machine-wide cap reports none.
	expect(queueLine({ limit: 4, running: 2, queued: 1 })).not.toHaveProperty("global");
});

test("a release gate shows the findings of the reviewer that feeds it", () => {
	const review: DagReviewView = {
		nodeId: "review",
		proposalId: "p1",
		disposition: "pending",
		valid: true,
		total: 1,
		findings: [{ severity: "high", file: "src/a.ts", summary: "Unchecked null" }],
		truncated: false,
	};
	const dag = {
		edges: [
			{ from: "gate-a", to: "review" },
			{ from: "review", to: "release" },
		],
	};
	const target = (nodeId: string) => ({ target: { nodeId, attempt: 1, activation: 1 } });
	expect(reviewForGate(target("review"), dag, { review })).toBe(review);
	expect(reviewForGate(target("release"), dag, { review })).toBe(review);
	expect(reviewForGate(target("land"), dag, { review })).toBeUndefined();
	expect(reviewForGate(target("release"), { edges: [] }, { review })).toBeUndefined();
});
