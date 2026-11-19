import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CommitAnalyzedPayload } from "@thinkrail/contracts";
import type { runReviewSubagent } from "../agent/delegation";
import {
	AUTO_ANALYZE_CAP,
	type CommitAnalysisDeps,
	type CommitSubagentRunner,
	createCommitAnalyzer,
} from "./commitAnalysis";
import type { CommitPackage } from "./commitPackage";
import { analysisSidecarPath } from "./store";

type RunnerIsCompatible = typeof runReviewSubagent extends CommitSubagentRunner ? true : false;

const A = "a".repeat(40);
const B = "b".repeat(40);
const fence = (v: unknown) => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;
const ANALYSIS = { intent: "i", summary: "s", riskFlags: [], fileNotes: [] };
const IMPACT = { modules: [], boundaryViolations: [], edgesChanged: [] };

let root: string;
let published: CommitAnalyzedPayload[];
let calls: { roleName: string; task: string }[];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "commit-analyzer-"));
	published = [];
	calls = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("the review subagent runner is assignable to CommitSubagentRunner (compile-time check)", () => {
	const compatible: RunnerIsCompatible = true;
	expect(compatible).toBe(true);
});

function deps(overrides: Partial<CommitAnalysisDeps> = {}): CommitAnalysisDeps {
	return {
		runSubagent: async (_ws, _parent, task, _role, _signal, info) => {
			calls.push({ roleName: info?.roleName ?? "", task });
			return {
				status: "completed",
				finalText: fence(info?.roleName === "commit-analyzer" ? ANALYSIS : IMPACT),
			};
		},
		resolveModel: async () => ({ model: { provider: "p", id: "m" } }),
		worktreeOf: () => root,
		readCommit: async (_ws, _root, sha): Promise<CommitPackage> => ({
			sha: sha.length === 40 ? sha : A,
			subject: "feat: x",
			files: [{ path: "src/a.ts", status: "modified" }],
			patch: "diff",
			truncated: false,
		}),
		publish: (p) => published.push(p),
		now: () => 42,
		...overrides,
	};
}

test("runs both children in parallel, stores the pair, publishes completed", async () => {
	const analyzer = createCommitAnalyzer(deps());
	const record = await analyzer.analyzeCommit("ws1", A, "parent", "manual");
	expect(record).toMatchObject({
		sha: A,
		subject: "feat: x",
		analyzedAt: 42,
		model: "p/m",
		analysis: ANALYSIS,
		architecture: IMPACT,
	});
	expect(calls.map((c) => c.roleName).sort()).toEqual(["architecture-mapper", "commit-analyzer"]);
	expect(analyzer.get("ws1", A)?.sha).toBe(A);
	expect(published).toEqual([{ workspaceId: "ws1", sha: A, status: "completed" }]);
});

test("an already-stored sha runs nothing", async () => {
	const analyzer = createCommitAnalyzer(deps());
	await analyzer.analyzeCommit("ws1", A, "parent", "manual");
	calls = [];
	expect((await analyzer.analyzeCommit("ws1", A, "parent", "manual"))?.sha).toBe(A);
	expect(calls).toEqual([]);
});

test("invalid child output is a failed analysis: no record, failed push", async () => {
	const analyzer = createCommitAnalyzer(
		deps({ runSubagent: async () => ({ status: "completed", finalText: "no json here" }) }),
	);
	expect(await analyzer.analyzeCommit("ws1", A, "parent", "manual")).toBeNull();
	expect(analyzer.get("ws1", A)).toBeNull();
	expect(published).toEqual([
		{ workspaceId: "ws1", sha: A, status: "failed", code: "COMMIT_ANALYSIS_INVALID_OUTPUT" },
	]);
});

test("one child not completing fails the whole analysis", async () => {
	const analyzer = createCommitAnalyzer(
		deps({
			runSubagent: async (_w, _p, _t, _r, _s, info) =>
				info?.roleName === "architecture-mapper"
					? { status: "aborted" }
					: { status: "completed", finalText: fence(ANALYSIS) },
		}),
	);
	expect(await analyzer.analyzeCommit("ws1", A, "parent", "manual")).toBeNull();
	expect(published[0]).toMatchObject({ status: "failed", code: "COMMIT_ANALYSIS_CHILD_FAILED" });
});

test("a throwing runner or git read never rejects", async () => {
	const throwing = createCommitAnalyzer(
		deps({
			runSubagent: async () => {
				throw new Error("provider down");
			},
		}),
	);
	expect(await throwing.analyzeCommit("ws1", A, "parent", "manual")).toBeNull();
	const noCommit = createCommitAnalyzer(deps({ readCommit: async () => null }));
	expect(await noCommit.analyzeCommit("ws1", B, "parent", "manual")).toBeNull();
	expect(published.at(-1)).toMatchObject({
		sha: B,
		status: "failed",
		code: "COMMIT_ANALYSIS_UNKNOWN_COMMIT",
	});
});

test("runs are serialized per workspace", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const analyzer = createCommitAnalyzer(
		deps({
			runSubagent: async (_w, _p, _t, _r, _s, info) => {
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				await new Promise((r) => setTimeout(r, 5));
				inFlight--;
				return {
					status: "completed",
					finalText: fence(info?.roleName === "commit-analyzer" ? ANALYSIS : IMPACT),
				};
			},
		}),
	);
	await Promise.all([
		analyzer.analyzeCommit("ws1", A, "parent", "manual"),
		analyzer.analyzeCommit("ws1", B, "parent", "manual"),
	]);
	expect(maxInFlight).toBe(2);
	expect(analyzer.list("ws1").shas.sort()).toEqual([A, B]);
});

test("auto path skips stored, pending and already-attempted shas", async () => {
	let fail = true;
	const analyzer = createCommitAnalyzer(
		deps({
			runSubagent: async (_w, _p, _t, _r, _s, info) =>
				fail
					? { status: "completed", finalText: "bad" }
					: {
							status: "completed",
							finalText: fence(info?.roleName === "commit-analyzer" ? ANALYSIS : IMPACT),
						},
		}),
	);
	await analyzer.analyzeNewCommits("ws1", "parent", [A, A]);
	await analyzer.settle("ws1");
	expect(published).toHaveLength(1);
	fail = false;
	await analyzer.analyzeNewCommits("ws1", "parent", [A]);
	await analyzer.settle("ws1");
	expect(published).toHaveLength(1);
	await analyzer.analyzeCommit("ws1", A, "parent", "manual");
	expect(analyzer.get("ws1", A)).not.toBeNull();
});

test("pending is visible while a run is queued", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const analyzer = createCommitAnalyzer(
		deps({
			runSubagent: async (_w, _p, _t, _r, _s, info) => {
				await gate;
				return {
					status: "completed",
					finalText: fence(info?.roleName === "commit-analyzer" ? ANALYSIS : IMPACT),
				};
			},
		}),
	);
	const run = analyzer.analyzeCommit("ws1", A, "parent", "manual");
	await Promise.resolve();
	expect(analyzer.isPending("ws1", A)).toBe(true);
	expect(analyzer.list("ws1").pending).toEqual([A]);
	release();
	await run;
	expect(analyzer.isPending("ws1", A)).toBe(false);
});

test("a rejected child aborts its sibling, and the next commit waits for the sibling to settle", async () => {
	const events: string[] = [];
	let siblingSignal: AbortSignal | undefined;
	const analyzer = createCommitAnalyzer(
		deps({
			runSubagent: async (_w, _p, task, _r, signal, info) => {
				const commit = task.includes(A) ? "A" : "B";
				const role = info?.roleName ?? "";
				events.push(`start:${commit}:${role}`);
				try {
					if (commit === "A" && role === "commit-analyzer") throw new Error("provider down");
					if (commit === "A") {
						if (!signal) throw new Error("child signal missing");
						siblingSignal = signal;
						await new Promise<void>((resolve) =>
							signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }),
						);
						return { status: "aborted" };
					}
					return {
						status: "completed",
						finalText: fence(role === "commit-analyzer" ? ANALYSIS : IMPACT),
					};
				} finally {
					events.push(`end:${commit}:${role}`);
				}
			},
		}),
	);
	const [first, second] = await Promise.all([
		analyzer.analyzeCommit("ws1", A, "parent", "manual"),
		analyzer.analyzeCommit("ws1", B, "parent", "manual"),
	]);
	expect(siblingSignal?.aborted).toBe(true);
	expect(first).toBeNull();
	expect(published[0]).toEqual({
		workspaceId: "ws1",
		sha: A,
		status: "failed",
		code: "COMMIT_ANALYSIS_CHILD_FAILED",
	});
	expect(second?.sha).toBe(B);
	const siblingEnd = events.indexOf("end:A:architecture-mapper");
	const nextStart = events.indexOf("start:B:commit-analyzer");
	expect(siblingEnd).toBeGreaterThanOrEqual(0);
	expect(nextStart).toBeGreaterThan(siblingEnd);
});

const shaN = (n: number) => String(n).repeat(40).slice(0, 40);

test("the auto trigger analyzes only the newest AUTO_ANALYZE_CAP shas", async () => {
	const analyzer = createCommitAnalyzer(deps());
	const shas = [1, 2, 3, 4, 5, 6, 7].map(shaN);
	await analyzer.analyzeNewCommits("ws1", "parent", shas);
	await analyzer.settle("ws1");
	expect(analyzer.list("ws1").shas.sort()).toEqual(shas.slice(-AUTO_ANALYZE_CAP).sort());
});

test("the auto trigger skips merge commits and counts the cap after the filter", async () => {
	const merges = new Set([shaN(7), shaN(6)]);
	const analyzer = createCommitAnalyzer(deps({ isMerge: (_root, sha) => merges.has(sha) }));
	const shas = [1, 2, 3, 4, 5, 6, 7].map(shaN);
	await analyzer.analyzeNewCommits("ws1", "parent", shas);
	await analyzer.settle("ws1");
	expect(analyzer.list("ws1").shas.sort()).toEqual([1, 2, 3, 4, 5].map(shaN).sort());
});

test("a merge commit stays available on demand", async () => {
	const analyzer = createCommitAnalyzer(deps({ isMerge: () => true }));
	expect((await analyzer.analyzeCommit("ws1", A, "parent", "manual"))?.sha).toBe(A);
});

test("an unreadable sidecar fails before any model call is spent", async () => {
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "{not json");
	const analyzer = createCommitAnalyzer(deps());
	expect(await analyzer.analyzeCommit("ws1", A, "parent", "manual")).toBeNull();
	expect(calls).toEqual([]);
	expect(published).toEqual([
		{ workspaceId: "ws1", sha: A, status: "failed", code: "COMMIT_ANALYSIS_SIDECAR_UNREADABLE" },
	]);
});

test("the record notes the checkout the children could read", async () => {
	const analyzer = createCommitAnalyzer(deps({ headOf: () => "c".repeat(40) }));
	expect((await analyzer.analyzeCommit("ws1", A, "parent", "manual"))?.checkout).toBe(
		"c".repeat(40),
	);
	const without = createCommitAnalyzer(deps({ headOf: () => null }));
	expect((await without.analyzeCommit("ws1", B, "parent", "manual"))?.checkout).toBeUndefined();
});

test("an invalid entry already stored under the sha fails the analysis instead of reporting success", async () => {
	const path = analysisSidecarPath(root, "ws1");
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ version: 1, items: { [A]: { sha: A } } }));
	const analyzer = createCommitAnalyzer(deps());
	expect(await analyzer.analyzeCommit("ws1", A, "parent", "manual")).toBeNull();
	expect(analyzer.get("ws1", A)).toBeNull();
	expect(published).toEqual([
		{ workspaceId: "ws1", sha: A, status: "failed", code: "COMMIT_ANALYSIS_WRITE_FAILED" },
	]);
});
