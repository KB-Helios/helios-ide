import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipDiff, FactoryRun } from "./run";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(): FactoryRun {
	const root = mkdtempSync(join(tmpdir(), "factory-coverage-"));
	roots.push(root);
	return new FactoryRun({
		workspaceId: "w",
		dagId: "d",
		cwd: root,
		worktreeRoot: root,
		isTrusted: () => true,
		releaseApproved: async () => false,
	});
}

test("a diff within its share is shown whole, with no marker", () => {
	const cut = clipDiff("a", "+one\n", 100);
	expect(cut).toEqual({ text: "+one\n", truncated: false, shown: 5, total: 5 });
});

test("a cut diff says how much is shown and how to see the rest", () => {
	const cut = clipDiff("coder-a", "x".repeat(500), 100);
	expect(cut.truncated).toBe(true);
	expect(cut.shown).toBe(100);
	expect(cut.total).toBe(500);
	expect(cut.text.startsWith("x".repeat(100))).toBe(true);
	expect(cut.text).toContain("[truncated: showing 100 of 500 characters of coder-a's diff.");
	expect(cut.text).toContain('source="coder-a"');
	expect(cut.text).toContain("factory_read");
});

test("the coverage record can never be a node's own metadata file", () => {
	const first = run();
	// Every valid node id starts with a letter or digit, so "diff-coverage" is a valid coder id.
	first.writeMeta({
		nodeId: "diff-coverage",
		branch: "b",
		path: "p",
		base: "x",
	} as unknown as Parameters<FactoryRun["writeMeta"]>[0]);
	first.notePartialDiffs(["a"]);
	expect(first.readPartialDiffs()).toEqual(["a"]);
	expect(first.readMeta("diff-coverage")?.branch).toBe("b");
});

test("partial diffs are recorded once per source and survive a new FactoryRun", () => {
	const first = run();
	expect(first.readPartialDiffs()).toEqual([]);
	first.notePartialDiffs([]);
	expect(first.readPartialDiffs()).toEqual([]);
	first.notePartialDiffs(["b", "a"]);
	first.notePartialDiffs(["a"]);
	expect(first.readPartialDiffs()).toEqual(["a", "b"]);
	const again = new FactoryRun(first.options);
	expect(again.readPartialDiffs()).toEqual(["a", "b"]);
});
