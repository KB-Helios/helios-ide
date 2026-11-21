import { expect, test } from "bun:test";
import type { FactoryRolesView } from "@thinkrail/contracts";
import {
	type CoderDraft,
	coderIssues,
	MAX_CODER_TASK,
	MAX_GLOBS,
	mayOverlap,
	newCoder,
	parseGlobs,
} from "./coderPlan";
import { type StartForm, startBlocker, startRequest } from "./factoryModel";

const coder = (key: string, patch: Partial<CoderDraft> = {}): CoderDraft => ({
	...newCoder(key, key),
	task: "Do it",
	owns: `src/${key}/**`,
	...patch,
});
const codes = (coders: CoderDraft[], runTask = "Run task") =>
	coderIssues(coders, runTask).map((issue) => `${issue.key}:${issue.code}`);

test("globs are one per line, trimmed, blank lines dropped", () => {
	expect(parseGlobs(" src/a/** \r\n\n  docs/*.md\n")).toEqual(["src/a/**", "docs/*.md"]);
	expect(parseGlobs("")).toEqual([]);
});

test("the overlap rule matches the host's conservative literal-prefix rule", () => {
	expect(mayOverlap(["src/a/**"], ["src/b/**"])).toBe(false);
	expect(mayOverlap(["src/**"], ["src/a/**"])).toBe(true);
	expect(mayOverlap(["src/a/x.ts"], ["src/a/**"])).toBe(true);
	expect(mayOverlap(["./src/a/**"], ["src\\a\\**"])).toBe(true);
	expect(mayOverlap(["**/*.ts"], ["src/a/**"])).toBe(true);
	expect(mayOverlap([], ["src/a/**"])).toBe(true);
	expect(mayOverlap(["src/a/**"], [])).toBe(true);
});

test("disjoint coders with tasks and owns are valid", () => {
	expect(codes([coder("a"), coder("b")])).toEqual([]);
});

test("a sole coder may leave owns and the task empty, several may not", () => {
	expect(codes([coder("a", { owns: "", task: "" })])).toEqual([]);
	expect(codes([coder("a", { owns: "", task: "" })], "")).toEqual(["a:task-missing"]);
	expect(codes([coder("a", { owns: "" }), coder("b")])).toEqual(["a:owns-required"]);
	expect(codes([coder("a", { task: "" }), coder("b")])).toEqual(["a:task-missing"]);
});

test("ids must be plain, unique and not reserved", () => {
	expect(codes([coder("a", { id: "Bad Id" })])).toEqual(["a:id-invalid"]);
	expect(codes([coder("a", { id: "1st" })])).toEqual(["a:id-invalid"]);
	expect(codes([coder("a", { id: "x".repeat(33) })])).toEqual(["a:id-invalid"]);
	for (const id of ["release", "land", "review", "planner", "gate-a"])
		expect(codes([coder("a", { id })])).toEqual(["a:id-reserved"]);
	expect(codes([coder("a", { id: "same" }), coder("b", { id: "same" })])).toEqual([
		"b:id-duplicate",
	]);
	expect(codes([coder("a", { id: " ok " })])).toEqual([]);
});

test("owns globs that may collide are named on the later row", () => {
	const issues = coderIssues(
		[coder("a", { owns: "src/**" }), coder("b", { owns: "src/b/**" }), coder("c")],
		"t",
	);
	expect(issues).toEqual([
		{ key: "b", code: "overlap", other: "a" },
		{ key: "c", code: "overlap", other: "a" },
	]);
});

test("globs must stay inside the repository and within the host's bounds", () => {
	for (const owns of ["/etc/**", "C:\\x\\**", "../up/**", "a/../b", "x".repeat(513)])
		expect(codes([coder("a", { owns })])).toEqual(["a:owns-invalid"]);
	expect(codes([coder("a", { avoid: "../x" })])).toEqual(["a:avoid-invalid"]);
	const many = Array.from({ length: MAX_GLOBS + 1 }, (_, i) => `d${i}/**`).join("\n");
	expect(codes([coder("a", { owns: many })])).toEqual(["a:owns-invalid"]);
	expect(codes([coder("a", { task: "x".repeat(MAX_CODER_TASK + 1) })])).toEqual(["a:task-long"]);
});

const view: FactoryRolesView = {
	models: [{ provider: "a", id: "m", name: "m", family: "alpha", reasoning: false }],
	defaults: {
		planner: { provider: "a", id: "m" },
		coder: { provider: "a", id: "m" },
		reviewer: { provider: "a", id: "m" },
		scout: { provider: "a", id: "m" },
	},
	sameFamilyOnly: false,
};
const form = (patch: Partial<StartForm>): StartForm => ({
	task: "Ship it",
	mode: "coders",
	coders: [],
	picks: { reviewer: "" },
	allowSameFamily: true,
	...patch,
});

test("the request carries each coder's trimmed id, task and non-empty globs", () => {
	const coders = [
		coder("a", { id: " alpha ", task: " One ", owns: "src/a/**\n", avoid: "src/a/gen/**" }),
		coder("b", { task: "Two", owns: "src/b/**" }),
	];
	expect(startRequest(view, form({ coders }))?.coders).toEqual([
		{ id: "alpha", task: "One", owns: ["src/a/**"], avoid: ["src/a/gen/**"] },
		{ id: "b", task: "Two", owns: ["src/b/**"] },
	]);
});

test("coder problems block the start and send nothing; planner mode ignores the rows", () => {
	const bad = [coder("a", { owns: "src/**" }), coder("b", { owns: "src/b/**" })];
	expect(startBlocker(view, form({ coders: bad }))).toBe("coders");
	expect(startRequest(view, form({ coders: bad }))).toBeNull();
	expect(startBlocker(view, form({ coders: [] }))).toBe("coders");
	const nine = Array.from({ length: 9 }, (_, i) =>
		coder(`c${i}`, { id: `c${i}`, owns: `d${i}/**` }),
	);
	expect(startBlocker(view, form({ coders: nine }))).toBe("coders");
	expect(startRequest(view, form({ mode: "plan", coders: bad }))?.coders).toBeUndefined();
});
