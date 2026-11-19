import { expect, test } from "bun:test";
import { isArchitectureImpact, isCommitAnalysis, isCommitAnalysisRecord } from "./commitAnalysis";

const analysis = {
	intent: "Add retry to the push path",
	summary: "Wraps push in a bounded retry.",
	riskFlags: [
		{ severity: "medium", title: "Retry loop", detail: "No jitter.", path: "src/push.ts" },
	],
	fileNotes: [{ path: "src/push.ts", note: "New retry helper." }],
};
const architecture = {
	modules: [
		{
			spec: "packages/server/src/pr/SPEC.md",
			module: "pr",
			paths: ["packages/server/src/pr/push.ts"],
			surfaceChanged: false,
		},
	],
	boundaryViolations: [
		{
			from: "pr",
			to: "host",
			path: "packages/server/src/pr/push.ts",
			rule: "Forbidden: host",
			detail: "imports ../host",
		},
	],
	edgesChanged: [{ from: "pr", to: "log", change: "added" }],
};

test("accepts well-formed analyzer and mapper output", () => {
	expect(isCommitAnalysis(analysis)).toBe(true);
	expect(isArchitectureImpact(architecture)).toBe(true);
	expect(
		isCommitAnalysisRecord({
			sha: "a".repeat(40),
			subject: "s",
			analyzedAt: 1,
			analysis,
			architecture,
		}),
	).toBe(true);
});

test("rejects unknown severity, missing arrays and wrong edge kinds", () => {
	expect(
		isCommitAnalysis({
			...analysis,
			riskFlags: [{ ...analysis.riskFlags[0], severity: "critical" }],
		}),
	).toBe(false);
	expect(isCommitAnalysis({ intent: "x", summary: "y", riskFlags: [] })).toBe(false);
	expect(
		isArchitectureImpact({
			...architecture,
			edgesChanged: [{ from: "a", to: "b", change: "moved" }],
		}),
	).toBe(false);
	expect(isArchitectureImpact({ modules: [], boundaryViolations: [] })).toBe(false);
});

test("rejects a record whose sha is not a full hex oid", () => {
	expect(
		isCommitAnalysisRecord({ sha: "HEAD", subject: "s", analyzedAt: 1, analysis, architecture }),
	).toBe(false);
});
