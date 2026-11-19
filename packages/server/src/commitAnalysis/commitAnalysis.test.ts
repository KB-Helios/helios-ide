import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitAnalyzedPayload } from "@thinkrail/contracts";
import type { runReviewSubagent } from "../agent/delegation";
import {
	type CommitAnalysisDeps,
	type CommitSubagentRunner,
	createCommitAnalyzer,
} from "./commitAnalysis";
import type { CommitPackage } from "./commitPackage";

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
