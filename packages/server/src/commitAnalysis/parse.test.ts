import { expect, test } from "bun:test";
import { lastFencedJson, parseArchitectureImpact, parseCommitAnalysis } from "./parse";

const fence = (v: unknown) => `Some notes first.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

test("takes the LAST fenced json block", () => {
	const text = `${fence({ a: 1 })}\nthen\n${fence({ a: 2 })}`;
	expect(lastFencedJson(text)).toEqual({ a: 2 });
});

test("no fence, bad json, or empty text is null", () => {
	expect(lastFencedJson(undefined)).toBeNull();
	expect(lastFencedJson("")).toBeNull();
	expect(lastFencedJson("```json\n{oops\n```")).toBeNull();
	expect(lastFencedJson('{"a":1}')).toBeNull();
});

test("analyzer output: valid parses, normalized and constructed explicitly", () => {
	const parsed = parseCommitAnalysis(
		fence({
			intent: "i",
			summary: "s",
			riskFlags: [
				{ severity: "high", title: "t", detail: "d", path: "src\\a.ts", extra: "dropped" },
			],
			fileNotes: [{ path: "src\\a.ts", note: "n" }],
			hallucinated: true,
		}),
	);
	expect(parsed).toEqual({
		intent: "i",
		summary: "s",
		riskFlags: [{ severity: "high", title: "t", detail: "d", path: "src/a.ts" }],
		fileNotes: [{ path: "src/a.ts", note: "n" }],
	});
});

test("analyzer output: an invalid shape is a failure, never partial", () => {
	expect(
		parseCommitAnalysis(
			fence({ intent: "i", summary: "s", riskFlags: [{ severity: "nope" }], fileNotes: [] }),
		),
	).toBeNull();
	expect(parseCommitAnalysis("I could not analyze this commit.")).toBeNull();
});

test("analyzer output: lists are capped", () => {
	const fileNotes = Array.from({ length: 500 }, (_, i) => ({ path: `f${i}.ts`, note: "n" }));
	const parsed = parseCommitAnalysis(
		fence({ intent: "i", summary: "s", riskFlags: [], fileNotes }),
	);
	expect(parsed?.fileNotes).toHaveLength(200);
});

test("mapper output: valid parses; wrong edge kind fails", () => {
	const ok = {
		modules: [{ spec: "a\\SPEC.md", module: "a", paths: ["a\\x.ts"], surfaceChanged: true }],
		boundaryViolations: [],
		edgesChanged: [{ from: "a", to: "b", change: "added" }],
	};
	expect(parseArchitectureImpact(fence(ok))).toEqual({
		modules: [{ spec: "a/SPEC.md", module: "a", paths: ["a/x.ts"], surfaceChanged: true }],
		boundaryViolations: [],
		edgesChanged: [{ from: "a", to: "b", change: "added" }],
	});
	expect(
		parseArchitectureImpact(fence({ ...ok, edgesChanged: [{ from: "a", to: "b", change: "x" }] })),
	).toBeNull();
});
