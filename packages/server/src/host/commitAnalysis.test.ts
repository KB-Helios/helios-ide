import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CommitAnalyzedPayload, Workspace } from "@thinkrail/contracts";
import {
	configurePiRuntime,
	createSession,
	disposeAllSessions,
	setSessionManagerFactory,
	setSessionPublisher,
	toWireModel,
} from "../agent";
import { saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import {
	commitAnalyzer,
	disposeCommitAnalysis,
	installCommitAnalysisRunnerForTests,
	requestCommitAnalysis,
	setCommitAnalyzedPublisher,
} from "./commitAnalysis";
import { handleRequest } from "./handlers";

const CTX = { clientKey: "commit-analysis-test" };

const WS = "ws-commit-analysis";
const TEST_ANALYSIS = { intent: "i", summary: "s", riskFlags: [], fileNotes: [] };
const TEST_IMPACT = { modules: [], boundaryViolations: [], edgesChanged: [] };
const fence = (v: unknown) => `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``;

function modelDef(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

const faux = createFauxCore({
	provider: "faux-worker",
	api: "faux-worker",
	models: [modelDef("faux-worker-model")],
	tokensPerSecond: 2000,
});

let dataDir: string;
let repo: string;
let branchSha: string;
let sessionId: string;
let published: CommitAnalyzedPayload[];

let priorAgentDir: string | undefined;
let priorOffline: string | undefined;

beforeAll(async () => {
	priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "trpi-commit-analysis-agentdir-"));
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("faux-worker", {
		api: faux.api,
		baseUrl: "http://faux-worker.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: [{ ...modelDef("faux-worker-model"), api: faux.api }],
	});
	configurePiRuntime(runtime);
	setSessionManagerFactory(() => SessionManager.inMemory());
	setSessionPublisher(() => {});
});

afterAll(() => {
	disposeAllSessions();
	setSessionPublisher(() => {});
	setSessionManagerFactory((cwd) => SessionManager.create(cwd));
	configurePiRuntime(null);
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
});

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(
		["git", "-C", cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (!r.success) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function commitFile(cwd: string, name: string, message: string): void {
	writeFileSync(join(cwd, name), `export const ${name.replace(/\W/g, "_")} = 1;\n`);
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", message);
}

beforeEach(async () => {
	dataDir = mkdtempSync(join(tmpdir(), "commit-analysis-data-"));
	repo = mkdtempSync(join(tmpdir(), "commit-analysis-repo-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	resetConfigCache();
	git(repo, "init", "-q", "-b", "main");
	commitFile(repo, "base.ts", "base");
	git(repo, "checkout", "-q", "-b", "feature");
	commitFile(repo, "feature.ts", "feat: add feature");
	branchSha = git(repo, "rev-parse", "HEAD");
	saveWorkspaces([
		{
			id: WS,
			projectId: "p1",
			name: "w",
			branch: "feature",
			baseBranch: "main",
			worktreePath: repo,
			createdAt: 0,
		} as Workspace,
	]);
	const created = await createSession({
		cwd: repo,
		workspaceId: WS,
		model: toWireModel(faux.getModel()),
		modelOptional: true,
	});
	sessionId = created.sessionId;
	published = [];
	setCommitAnalyzedPublisher((payload) => published.push(payload));
});

afterEach(() => {
	disposeCommitAnalysis();
	delete process.env.THINKRAIL_DATA_DIR;
	resetConfigCache();
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(repo, { recursive: true, force: true });
});

function errorOf(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
}

const fakeRunner = async (
	_workspaceId: string,
	_parentSessionId: string,
	_task: string,
	_role: unknown,
	_signal?: AbortSignal,
	info?: { createdBy: string; roleName: string },
) => ({
	status: "completed",
	finalText: fence(info?.roleName === "commit-analyzer" ? TEST_ANALYSIS : TEST_IMPACT),
});

test("commit.analyze rejects a sha outside the branch's listed commits", () => {
	expect(() => requestCommitAnalysis(WS, "f".repeat(40), sessionId)).toThrow(/not on this branch/);
});

test("commit.analyze without a live chat is a coded error", () => {
	expect(errorOf(() => requestCommitAnalysis(WS, branchSha, undefined, () => []))).toMatchObject({
		code: "COMMIT_ANALYSIS_NO_SESSION",
	});
});

test("queues, then stores; a second request reports stored", async () => {
	installCommitAnalysisRunnerForTests(fakeRunner);
	expect(requestCommitAnalysis(WS, branchSha, sessionId)).toEqual({ status: "queued" });
	await commitAnalyzer().settle(WS);
	expect(requestCommitAnalysis(WS, branchSha, sessionId)).toEqual({ status: "stored" });
	expect(commitAnalyzer().get(WS, branchSha)?.analysis.intent).toBe("i");
	expect(published).toEqual([{ workspaceId: WS, sha: branchSha, status: "completed" }]);
});

test("the wire handlers queue, canonicalise a short sha, and list the analysed shas", async () => {
	installCommitAnalysisRunnerForTests(fakeRunner);
	expect(
		await handleRequest("commit.analysis", { workspaceId: WS, sha: branchSha }, CTX),
	).toBeNull();
	expect(
		await handleRequest(
			"commit.analyze",
			{ workspaceId: WS, sha: branchSha.slice(0, 10), sessionId },
			CTX,
		),
	).toEqual({ status: "queued" });
	await commitAnalyzer().settle(WS);
	expect(await handleRequest("commit.analysisList", { workspaceId: WS }, CTX)).toEqual({
		shas: [branchSha],
		pending: [],
	});
	expect(
		await handleRequest("commit.analysis", { workspaceId: WS, sha: branchSha.slice(0, 10) }, CTX),
	).toMatchObject({ sha: branchSha, analysis: { intent: "i" } });
});
