import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommitAnalysisRecord } from "@thinkrail/contracts";
import { analysisSidecarPath, readAnalyses, readAnalysis, writeAnalysisOnce } from "./store";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "commit-analysis-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const record = (sha: string, summary = "s"): CommitAnalysisRecord => ({
	sha,
	subject: "subject",
	analyzedAt: 1,
	analysis: { intent: "i", summary, riskFlags: [], fileNotes: [] },
	architecture: { modules: [], boundaryViolations: [], edgesChanged: [] },
});
const A = "a".repeat(40);
const B = "b".repeat(40);

test("writes once per sha and reads back", () => {
	expect(writeAnalysisOnce(root, "ws1", record(A))).toBe(true);
	expect(writeAnalysisOnce(root, "ws1", record(B))).toBe(true);
	expect(writeAnalysisOnce(root, "ws1", record(A, "changed"))).toBe(false);
	expect(readAnalysis(root, "ws1", A)?.analysis.summary).toBe("s");
	expect(Object.keys(readAnalyses(root, "ws1")).sort()).toEqual([A, B]);
	expect(analysisSidecarPath(root, "ws1")).toBe(
		join(root, ".thinkrail/context/commits/ws1.analysis.json"),
	);
	expect(existsSync(`${analysisSidecarPath(root, "ws1")}.tmp`)).toBe(false);
});

test("a corrupt file or a malformed entry reads as absent", () => {
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{not json");
	expect(readAnalyses(root, "ws1")).toEqual({});
	writeFileSync(path, JSON.stringify({ version: 1, items: { [A]: { sha: A }, [B]: record(B) } }));
	expect(Object.keys(readAnalyses(root, "ws1"))).toEqual([B]);
});

test("a record is stored under its own sha only", () => {
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, items: { [A]: record(B) } }));
	expect(readAnalyses(root, "ws1")).toEqual({});
});

test("refuses a workspace id that is not a plain path segment", () => {
	expect(() => writeAnalysisOnce(root, "../evil", record(A))).toThrow();
	expect(readAnalyses(root, "../evil")).toEqual({});
});
