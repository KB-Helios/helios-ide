import { expect, test } from "bun:test";
import { capPatch, renderCommitTask } from "./commitPackage";

test("capPatch keeps short patches and truncates long ones at a line boundary", () => {
	expect(capPatch("a\nb\n", 100)).toEqual({ patch: "a\nb\n", truncated: false });
	const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
	const capped = capPatch(long, 50);
	expect(capped.truncated).toBe(true);
	expect(capped.patch.length).toBeLessThanOrEqual(50);
	expect(capped.patch.endsWith("\n")).toBe(true);
});

test("renderCommitTask names the sha, files, truncation, and the contract last", () => {
	const text = renderCommitTask(
		{
			sha: "a".repeat(40),
			subject: "feat: x",
			files: [{ path: "src/a.ts", status: "modified", additions: 3, deletions: 1 }],
			patch: "diff --git a/src/a.ts b/src/a.ts\n",
			truncated: true,
		},
		"CONTRACT",
	);
	expect(text).toContain("aaaaaaaa");
	expect(text).toContain("feat: x");
	expect(text).toContain("src/a.ts (modified, +3 -1)");
	expect(text).toContain("truncated");
	expect(text.trimEnd().endsWith("CONTRACT")).toBe(true);
});
