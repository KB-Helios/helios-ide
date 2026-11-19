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

const record = { sha: "a".repeat(40), subject: "s", analyzedAt: 1, analysis, architecture };

test("required content strings must be non-empty after trim", () => {
	expect(isCommitAnalysis({ ...analysis, intent: "" })).toBe(false);
	expect(isCommitAnalysis({ ...analysis, summary: "   " })).toBe(false);
	expect(
		isCommitAnalysis({
			...analysis,
			riskFlags: [{ ...analysis.riskFlags[0], title: " \t " }],
		}),
	).toBe(false);
	expect(
		isCommitAnalysis({
			...analysis,
			fileNotes: [{ path: "", note: "n" }],
		}),
	).toBe(false);
	expect(
		isArchitectureImpact({
			...architecture,
			modules: [{ ...architecture.modules[0], paths: [""] }],
		}),
	).toBe(false);
	expect(
		isArchitectureImpact({
			...architecture,
			boundaryViolations: [{ ...architecture.boundaryViolations[0], rule: "  " }],
		}),
	).toBe(false);
	expect(
		isArchitectureImpact({
			...architecture,
			edgesChanged: [{ from: "", to: "b", change: "added" }],
		}),
	).toBe(false);
});

test("an empty commit subject is still accepted", () => {
	expect(isCommitAnalysisRecord({ ...record, subject: "" })).toBe(true);
});

test("an optional path or model, when present, must be non-empty", () => {
	expect(
		isCommitAnalysis({
			...analysis,
			riskFlags: [{ ...analysis.riskFlags[0], path: "" }],
		}),
	).toBe(false);
	expect(isCommitAnalysisRecord({ ...record, model: "" })).toBe(false);
	expect(isCommitAnalysisRecord({ ...record, model: "claude-haiku" })).toBe(true);
});

test("analyzedAt must be a finite non-negative number", () => {
	expect(isCommitAnalysisRecord({ ...record, analyzedAt: Number.NaN })).toBe(false);
	expect(isCommitAnalysisRecord({ ...record, analyzedAt: -1 })).toBe(false);
	expect(isCommitAnalysisRecord({ ...record, analyzedAt: Number.POSITIVE_INFINITY })).toBe(false);
	expect(isCommitAnalysisRecord({ ...record, analyzedAt: 0 })).toBe(true);
});

test("unknown extra keys are tolerated, not rejected", () => {
	expect(isCommitAnalysis({ ...analysis, extra: "ignored" })).toBe(true);
	expect(isCommitAnalysisRecord({ ...record, extra: { nested: true } })).toBe(true);
});
