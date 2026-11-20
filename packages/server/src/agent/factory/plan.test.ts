import { expect, test } from "bun:test";
import {
	buildPlanningDefinition,
	encodePlanRun,
	isPlannerNode,
	MAX_PLAN_CODERS,
	PlanError,
	type PlanRun,
	parseCoderPlans,
	parsePlanRun,
} from "./plan";

const selection = (id: string) => ({
	model: { provider: "p", id },
	thinkingLevel: "medium" as const,
});
const run: PlanRun = {
	title: "Add the thing",
	target: "main",
	gateRetries: 2,
	notes: ["a note"],
	roles: { coder: selection("c"), reviewer: selection("r"), scout: selection("s") },
};

test("a valid plan is normalised and a single coder may own everything", () => {
	expect(parseCoderPlans({ coders: [{ id: "solo", task: "  Do it  " }] })).toEqual([
		{ id: "solo", task: "Do it" },
	]);
	expect(
		parseCoderPlans([
			{ id: "api", task: "a", owns: ["src/api/**"], avoid: ["src/api/gen/**"] },
			{ id: "web", task: "b", owns: ["src/web/**"] },
		]),
	).toEqual([
		{ id: "api", task: "a", owns: ["src/api/**"], avoid: ["src/api/gen/**"] },
		{ id: "web", task: "b", owns: ["src/web/**"] },
	]);
});

test("every way a model could widen or break a plan is rejected with a plain reason", () => {
	const reject = (value: unknown, text: string) => {
		expect(() => parseCoderPlans(value)).toThrow(PlanError);
		expect(() => parseCoderPlans(value)).toThrow(text);
	};
	reject(undefined, "at least one coder");
	reject({ coders: [] }, "at least one coder");
	reject({ coders: [{ id: "a", task: "x" }], extra: 1 }, "unexpected fields");
	reject({ coders: [{ id: "a", task: "x", model: "big" }] }, "unexpected fields");
	reject(
		{ coders: Array.from({ length: MAX_PLAN_CODERS + 1 }, (_, i) => ({ id: `c${i}`, task: "x" })) },
		"at most",
	);
	reject({ coders: [{ id: "A", task: "x" }] }, "needs an id");
	reject({ coders: [{ id: "1a", task: "x" }] }, "needs an id");
	for (const id of ["release", "land", "review", "planner", "gate-a"])
		reject({ coders: [{ id, task: "x" }] }, "reserved");
	reject(
		{
			coders: [
				{ id: "a", task: "x", owns: ["a/**"] },
				{ id: "a", task: "y", owns: ["b/**"] },
			],
		},
		"used twice",
	);
	reject({ coders: [{ id: "a", task: "" }] }, "needs a task");
	reject({ coders: [{ id: "a", task: "x".repeat(8001) }] }, "needs a task");
	reject({ coders: [{ id: "a", task: "x", owns: ["../x/**"] }] }, "inside the repository");
	reject({ coders: [{ id: "a", task: "x", owns: ["src/../../x"] }] }, "inside the repository");
	reject({ coders: [{ id: "a", task: "x", owns: ["/etc/**"] }] }, "inside the repository");
	reject({ coders: [{ id: "a", task: "x", owns: ["C:/x/**"] }] }, "inside the repository");
	reject({ coders: [{ id: "a", task: "x", avoid: [""] }] }, "invalid glob");
	reject({ coders: [{ id: "a", task: "x", owns: "src/**" }] }, "list");
	reject(
		{
			coders: [
				{ id: "a", task: "x" },
				{ id: "b", task: "y" },
			],
		},
		"needs owns",
	);
	reject(
		{
			coders: [
				{ id: "a", task: "x", owns: ["src/**"] },
				{ id: "b", task: "y", owns: ["src/b/**"] },
			],
		},
		"disjoint",
	);
});

test("the person's choices travel in the planner's frozen prompt and nothing else parses", () => {
	expect(parsePlanRun(`prompt\n\n${encodePlanRun(run)}`)).toEqual(run);
	expect(parsePlanRun(undefined)).toBeUndefined();
	expect(parsePlanRun("no marker")).toBeUndefined();
	expect(parsePlanRun(encodePlanRun({ ...run, gateRetries: 9 }))).toBeUndefined();
	expect(parsePlanRun(encodePlanRun({ ...run, extra: 1 } as PlanRun))).toBeUndefined();
	expect(parsePlanRun("<factory-plan>{not json</factory-plan>")).toBeUndefined();
});

test("the planning DAG is one read-only planner with a human-approved json plan", () => {
	const definition = buildPlanningDefinition({
		task: "Add the thing",
		planner: { ...selection("planner"), family: "p" },
		run,
	});
	expect(definition.nodes).toHaveLength(1);
	const [planner] = definition.nodes;
	expect(planner?.id).toBe("planner");
	expect(planner?.session?.tools).toEqual(["read", "grep", "find", "ls"]);
	expect(planner?.session?.model).toEqual({ provider: "p", id: "planner" });
	expect(planner?.approval?.authority).toBe("human");
	expect(isPlannerNode(planner?.outputs ?? {})).toBe(true);
	expect(isPlannerNode({ plan: { kind: "text" } })).toBe(false);
	expect(isPlannerNode({ plan: { kind: "json" }, other: { kind: "text" } })).toBe(false);
	expect(parsePlanRun(planner?.session?.systemPrompt)).toEqual(run);
	expect(planner?.task).toContain("Add the thing");
});
