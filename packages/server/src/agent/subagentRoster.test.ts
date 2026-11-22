import { describe, expect, test } from "bun:test";
import type { DelegationService, LifecycleEvent } from "pi-delegation";
import { createSubagentRoster, setSubagentRosterPublisher } from "./subagentRoster";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0.01,
	turns: 1,
	contextTokens: 15,
};

function details(
	sessionId: string,
	status: "queued" | "running" | "completed" | "error" | "aborted",
) {
	return {
		childSessionId: sessionId,
		task: "t",
		status,
		usage,
		durationMs: 5,
		activity: "reading",
	};
}

function fakeService(children: Record<string, { createdBy?: string; noActivity?: boolean }>) {
	return {
		findChild: (id: string) => {
			const spec = children[id];
			if (!spec) return undefined;
			return {
				record: {
					sessionId: id,
					parentSessionId: "parent-1",
					scope: "ws",
					info: { createdBy: spec.createdBy ?? "tool:Agent", roleName: "worker" },
					// pi-delegation's only V1 visibility: every real child is hidden.
					visibility: "hidden",
					createdAt: "2026-01-01T00:00:00.000Z",
				},
				snapshot: {
					status: "queued",
					task: "t",
					details: spec.noActivity
						? { ...details(id, "queued"), activity: undefined }
						: details(id, "queued"),
				},
			};
		},
	} as unknown as DelegationService;
}

function harness(children: Record<string, { createdBy?: string; noActivity?: boolean }>) {
	let clock = 1_000_000;
	const timers: (() => void)[] = [];
	const published: string[] = [];
	setSubagentRosterPublisher((p) => published.push(p.workspaceId));
	const roster = createSubagentRoster({
		workspaceId: "ws",
		service: fakeService(children),
		titleOf: () => "Auth refactor",
		now: () => clock,
		setTimer: (fn) => {
			timers.push(fn);
			return timers.length;
		},
		clearTimer: () => {},
	});
	return {
		roster,
		published,
		advance: (ms: number) => {
			clock += ms;
		},
		flush: () => {
			for (const fn of timers.splice(0)) fn();
		},
	};
}

const ev = (type: "run-queued" | "run-started", id: string): LifecycleEvent => ({
	type,
	sessionId: id,
	parentSessionId: "parent-1",
});

describe("subagent roster", () => {
	test("tracks transitions and carries the parent title", () => {
		const h = harness({ a: {} });
		h.roster.handle(ev("run-queued", "a"));
		expect(h.roster.read().counts.queued).toBe(1);
		h.roster.handle(ev("run-started", "a"));
		h.roster.handle({
			type: "run-progress",
			sessionId: "a",
			parentSessionId: "parent-1",
			details: details("a", "running"),
		});
		const read = h.roster.read();
		expect(read.counts.running).toBe(1);
		expect(read.rows[0]?.parentTitle).toBe("Auth refactor");
		expect(read.rows[0]?.activity).toBe("reading");
		expect(read.rows[0]?.usage?.output).toBe(5);
	});

	test("coalesces progress into one publish", () => {
		const h = harness({ a: {} });
		h.roster.handle(ev("run-started", "a"));
		for (let i = 0; i < 5; i++)
			h.roster.handle({
				type: "run-progress",
				sessionId: "a",
				parentSessionId: "parent-1",
				details: details("a", "running"),
			});
		h.flush();
		expect(h.published).toEqual(["ws"]);
		expect(h.roster.read().revision).toBeGreaterThan(1);
	});

	test("lists Agent-tool, review and swarm children although delegation marks them hidden", () => {
		const h = harness({
			a: { createdBy: "tool:Agent" },
			r: { createdBy: "tool:request_review" },
			s: { createdBy: "tool:swarm_add" },
		});
		for (const id of ["a", "r", "s"]) h.roster.handle(ev("run-started", id));
		expect(
			h.roster
				.read()
				.rows.map((row) => row.childSessionId)
				.sort(),
		).toEqual(["a", "r", "s"]);
	});

	test("leaves the host's internal helpers out", () => {
		const h = harness({ c: { createdBy: "host:commit-analysis" } });
		h.roster.handle(ev("run-started", "c"));
		expect(h.roster.read().rows).toHaveLength(0);
	});

	test("keeps failures after the done TTL and drops finished rows", () => {
		const h = harness({ ok: {}, bad: {} });
		for (const id of ["ok", "bad"]) h.roster.handle(ev("run-started", id));
		h.roster.handle({
			type: "run-terminal",
			sessionId: "ok",
			parentSessionId: "parent-1",
			outcome: { status: "completed", details: details("ok", "completed"), finalText: "done" },
		} as unknown as LifecycleEvent);
		h.roster.handle({
			type: "run-terminal",
			sessionId: "bad",
			parentSessionId: "parent-1",
			outcome: {
				status: "error",
				details: details("bad", "error"),
				errorMessage: "boom",
			},
		} as unknown as LifecycleEvent);
		expect(h.roster.read().counts).toMatchObject({ done: 1, failed: 1 });
		h.advance(10 * 60_000);
		const after = h.roster.read();
		expect(after.rows.map((r) => r.childSessionId)).toEqual(["bad"]);
		expect(after.rows[0]?.errorMessage).toBe("boom");
	});

	test("dropping a disposed live child removes its row", () => {
		const h = harness({ a: {} });
		h.roster.handle(ev("run-started", "a"));
		h.roster.handle({ type: "child-disposed", sessionId: "a", parentSessionId: "parent-1" });
		expect(h.roster.read().rows).toHaveLength(0);
	});
	const terminal = (
		id: string,
		status: "completed" | "error",
		extra: Record<string, unknown> = {},
	): LifecycleEvent =>
		({
			type: "run-terminal",
			sessionId: id,
			parentSessionId: "parent-1",
			outcome: { status, details: details(id, status), ...extra },
		}) as unknown as LifecycleEvent;

	test("an idle workspace publishes when a finished row expires", () => {
		const h = harness({ a: {} });
		h.roster.handle(ev("run-started", "a"));
		h.roster.handle(terminal("a", "completed", { finalText: "ok" }));
		h.flush();
		const before = h.published.length;
		h.advance(3 * 60_000);
		h.flush();
		h.flush();
		expect(h.published.length).toBeGreaterThan(before);
		expect(h.roster.read().rows).toHaveLength(0);
	});

	test("pruning on read bumps the revision", () => {
		const h = harness({ a: {} });
		h.roster.handle(ev("run-started", "a"));
		h.roster.handle(terminal("a", "completed"));
		const first = h.roster.read();
		h.advance(3 * 60_000);
		const second = h.roster.read();
		expect(second.rows).toHaveLength(0);
		expect(second.revision).toBeGreaterThan(first.revision);
		expect(h.roster.read().revision).toBe(second.revision);
	});

	test("the terminal cap holds without any read", () => {
		const children: Record<string, object> = {};
		for (let i = 0; i < 60; i++) children[`c${i}`] = {};
		const h = harness(children);
		for (let i = 0; i < 60; i++) {
			h.roster.handle(ev("run-started", `c${i}`));
			h.roster.handle(terminal(`c${i}`, "error", { errorMessage: "x" }));
			h.advance(10);
		}
		expect(h.roster.read().rows).toHaveLength(50);
	});

	test("a re-run clears the previous run's terminal fields", () => {
		const h = harness({ a: { noActivity: true } });
		h.roster.handle(ev("run-started", "a"));
		h.roster.handle(terminal("a", "error", { errorMessage: "boom", finalText: "old" }));
		h.roster.handle(ev("run-started", "a"));
		const running = h.roster.read().rows[0];
		expect(running?.status).toBe("running");
		expect(running?.errorMessage).toBeUndefined();
		expect(running?.finalText).toBeUndefined();
		expect(running?.finishedAt).toBeUndefined();
		expect(running?.activity).toBeUndefined();
		h.roster.handle(terminal("a", "completed"));
		expect(h.roster.read().rows[0]?.errorMessage).toBeUndefined();
	});

	test("a read that prunes also publishes, before the expiry timer fires", () => {
		const h = harness({ a: {} });
		h.roster.handle(ev("run-started", "a"));
		h.roster.handle({
			type: "run-terminal",
			sessionId: "a",
			parentSessionId: "parent-1",
			outcome: { status: "completed", details: details("a", "completed") },
		} as unknown as LifecycleEvent);
		h.flush();
		const before = h.published.length;
		h.advance(3 * 60_000);
		expect(h.roster.read().rows).toHaveLength(0);
		h.flush();
		expect(h.published.length).toBeGreaterThan(before);
	});
});
