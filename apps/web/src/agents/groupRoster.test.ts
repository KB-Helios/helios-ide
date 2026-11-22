import { expect, test } from "bun:test";
import type { SubagentRosterRow } from "@thinkrail/contracts";
import type { Translator } from "@thinkrail/locales/react";
import { formatAgentElapsed, groupRoster, isStoppableAgent } from "./groupRoster";

const row = (id: string, status: SubagentRosterRow["status"]): SubagentRosterRow => ({
	childSessionId: id,
	parentSessionId: "p",
	parentTitle: "Chat",
	task: "t",
	status,
	createdAt: "2026-01-01T00:00:00.000Z",
});

test("failures lead; groups are state-first and empty groups are omitted", () => {
	const groups = groupRoster([
		row("a", "completed"),
		row("b", "running"),
		row("c", "error"),
		row("d", "queued"),
		row("e", "aborted"),
	]);
	expect(groups.map((g) => g.id)).toEqual(["failed", "working", "queued", "stopped", "done"]);
	// A stopped run gets its own group and never reads as done.
	expect(groups[3]?.rows.map((r) => r.childSessionId)).toEqual(["e"]);
	expect(groups[4]?.rows.map((r) => r.childSessionId)).toEqual(["a"]);
});

test("only live rows are stoppable", () => {
	expect(isStoppableAgent(row("a", "running"))).toBe(true);
	expect(isStoppableAgent(row("a", "queued"))).toBe(true);
	expect(isStoppableAgent(row("a", "error"))).toBe(false);
});

const t = ((key: string, params?: Record<string, string | number>) =>
	`${key}:${Object.values(params ?? {}).join(",")}`) as unknown as Translator;

test("elapsed formatting", () => {
	expect(formatAgentElapsed(12_000, t)).toBe("agents.duration.seconds:12");
	expect(formatAgentElapsed(125_000, t)).toBe("agents.duration.minutes:2");
	expect(formatAgentElapsed(3_900_000, t)).toBe("agents.duration.hours:1,5");
});
