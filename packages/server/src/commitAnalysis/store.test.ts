import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("an inherited property name is never a stored analysis", () => {
	writeAnalysisOnce(root, "ws1", record(A));
	for (const name of ["__proto__", "constructor", "toString"]) {
		expect(readAnalysis(root, "ws1", name)).toBeNull();
	}
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

test("an unreadable sidecar makes a write throw and leaves the file unchanged", () => {
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{not json");
	expect(() => writeAnalysisOnce(root, "ws1", record(A))).toThrow();
	expect(readFileSync(path, "utf8")).toBe("{not json");
	expect(existsSync(`${path}.tmp`)).toBe(false);
});

test("a sha with an invalid stored entry is not overwritten and the entry stays", () => {
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	const raw = JSON.stringify({ version: 1, items: { [A]: { sha: A, junk: true } } });
	writeFileSync(path, raw);
	expect(writeAnalysisOnce(root, "ws1", record(A))).toBe(false);
	expect(readFileSync(path, "utf8")).toBe(raw);
	expect(readAnalyses(root, "ws1")).toEqual({});
});

test("writing a new sha keeps an invalid raw entry under another sha verbatim", () => {
	const C = "c".repeat(40);
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, items: { [C]: { bad: 1 } } }));
	expect(writeAnalysisOnce(root, "ws1", record(B))).toBe(true);
	const stored = JSON.parse(readFileSync(path, "utf8")) as { items: Record<string, unknown> };
	expect(JSON.stringify(stored.items[C])).toBe(JSON.stringify({ bad: 1 }));
	expect(Object.keys(readAnalyses(root, "ws1"))).toEqual([B]);
});
