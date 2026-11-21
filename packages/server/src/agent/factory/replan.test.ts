import { expect, test } from "bun:test";
import { MAX_TASK_CHARS } from "./plan";
import { buildReplanTask, REPLAN_FINDINGS_MAX, type ReplanFeedback } from "./replan";

const feedback = (over: Partial<ReplanFeedback> = {}): ReplanFeedback => ({
	reason: "Too risky",
	gate: "release",
	findings: [],
	findingsTotal: 0,
	gates: [],
	factoryDagId: "dag-1",
	...over,
});

test("the replan task holds the original task, the person's reason, the findings and the gate verdicts", () => {
	const task = buildReplanTask(
		"Add the thing",
		feedback({
			findings: [{ severity: "high", file: "src/a.ts", summary: "Leaks" }],
			findingsTotal: 1,
			gates: [{ id: "gate-api", report: "FAIL\nlint" }],
		}),
	);
	expect(task.startsWith("Add the thing")).toBe(true);
	expect(task).toContain("release step");
	expect(task).toContain("Too risky");
	expect(task).toContain("- [high] src/a.ts: Leaks");
	expect(task).toContain("- gate-api: FAIL lint");
	expect(task).toContain("dag-1");
});

test("sections with nothing to report are left out", () => {
	const task = buildReplanTask("Add the thing", feedback());
	expect(task).not.toContain("Reviewer findings");
	expect(task).not.toContain("Gate verdicts");
});

test("every part is cut with a note and the whole stays within the task limit", () => {
	const task = buildReplanTask(
		"o".repeat(MAX_TASK_CHARS),
		feedback({
			reason: "r".repeat(MAX_TASK_CHARS),
			findings: Array.from({ length: 100 }, (_, index) => ({
				severity: "low",
				file: `f${index}`,
				summary: "s".repeat(1000),
			})),
			findingsTotal: 100,
			gates: Array.from({ length: 8 }, (_, index) => ({
				id: `gate-${index}`,
				report: "g".repeat(5000),
			})),
		}),
	);
	expect(task.length).toBeLessThanOrEqual(MAX_TASK_CHARS);
	expect(task).toContain("[truncated]");
	expect(task).toContain("Reason the person gave");
	// The original task survives even when everything else is huge.
	expect(task.startsWith("ooo")).toBe(true);
	expect(REPLAN_FINDINGS_MAX).toBeLessThan(100);
});

test("findings beyond the listed ones are counted, not quoted", () => {
	const findings = Array.from({ length: REPLAN_FINDINGS_MAX + 5 }, (_, index) => ({
		severity: "low",
		file: `f${index}`,
		summary: "x",
	}));
	const task = buildReplanTask("t", feedback({ findings, findingsTotal: findings.length + 3 }));
	expect(task).toContain("- [low] f0: x");
	expect(task).not.toContain(`f${REPLAN_FINDINGS_MAX}:`);
	expect(task).toContain("(8 more findings not shown)");
});
