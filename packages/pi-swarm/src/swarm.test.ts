import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createDelegationService, type DelegationService } from "pi-delegation";
import { BUILTIN_AGENTS } from "pi-subagents";
import { Board, COORDINATOR, parseMentions } from "./board.ts";
import { detectGates, runProjectGates } from "./gates.ts";
import {
	changedFiles,
	createWorktree,
	GIT_ENV,
	matchesAny,
	ownershipViolations,
	removeWorktree,
} from "./git.ts";
import { swarmMemberExtension } from "./memberExtension.ts";
import { reviewVerdict } from "./prompts.ts";
import { Swarm, type SwarmSnapshot } from "./swarm.ts";

const faux = createFauxCore({
	provider: "faux",
	api: "faux",
	models: [
		{
			id: "faux",
			name: "faux",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 4096,
		},
	],
	tokensPerSecond: 4000,
});

const dirs: string[] = [];
const tmp = (prefix: string) => {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
};
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, ...GIT_ENV },
	});

let runtime: ModelRuntime;
let parent: AgentSession;
let repo: string;
let service: DelegationService;
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(async () => {
	process.env.PI_CODING_AGENT_DIR = tmp("swarm-agentdir-");
	process.env.PI_OFFLINE = "1";
	runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider("faux", {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "faux",
		streamSimple: faux.streamSimple,
		models: faux.models,
	});
	repo = tmp("swarm-repo-");
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "README.md"), "hi\n");
	mkdirSync(join(repo, "src"));
	writeFileSync(join(repo, "src", "keep.ts"), "export {};\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	const model = runtime.getModel("faux", "faux");
	parent = (
		await createAgentSession({
			cwd: repo,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(repo),
			settingsManager: SettingsManager.inMemory({}),
			...(model ? { model } : {}),
		})
	).session;
	service = createDelegationService({
		resolveParent: (id) =>
			id === parent.sessionId
				? { cwd: repo, model: parent.model, thinkingLevel: parent.thinkingLevel }
				: undefined,
		delegationRoot: tmp("swarm-delegation-"),
		scope: "test",
		modelRuntime: runtime,
		childExtensionFactories: [swarmMemberExtension],
	});
});

afterAll(() => {
	parent?.dispose();
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	for (const dir of dirs)
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
});

test("mentions resolve to members, groups and @all, never the sender", () => {
	const board = new Board();
	const base = {
		kind: "worker" as const,
		status: "waiting" as const,
		phase: "working" as const,
		readCursor: 0,
		fixRounds: 0,
		createdAt: "",
	};
	board.add({ ...base, name: "parser", brief: { task: "", owns: [], avoid: [] } });
	board.add({ ...base, name: "fix-1", group: "fix", brief: { task: "", owns: [], avoid: [] } });
	board.add({ ...base, name: "fix-2", group: "fix", brief: { task: "", owns: [], avoid: [] } });
	expect(parseMentions("ping @Parser and @fix, email a@b.c")).toEqual(["parser", "fix"]);
	expect(board.post("parser", "@fix please", "message").to).toEqual(["fix-1", "fix-2"]);
	expect(board.post("fix-1", "@all done", "message").to.sort()).toEqual(
		[COORDINATOR, "fix-2", "parser"].sort(),
	);
	expect(board.takeUnread("fix-2").map((p) => p.seq)).toEqual([1, 2]);
	expect(board.takeUnread("fix-2")).toEqual([]);
	expect(() =>
		board.add({ ...base, name: "fix", brief: { task: "", owns: [], avoid: [] } }),
	).toThrow("group");
	expect(board.graph()).toContainEqual({ from: "parser", to: "fix-1", count: 1 });
});

test("ownership flags files outside owns and inside avoid", () => {
	expect(
		ownershipViolations(["src/a.ts", "src/b/c.ts", "docs/x.md"], {
			owns: ["src/"],
			avoid: ["src/b/**"],
		}),
	).toEqual(["src/b/c.ts", "docs/x.md"]);
});

test("a **/ glob keeps the path-component boundary", () => {
	expect(matchesAny("src/foo.ts", ["src/**/foo.ts"])).toBe(true);
	expect(matchesAny("src/a/b/foo.ts", ["src/**/foo.ts"])).toBe(true);
	expect(matchesAny("src/notfoo.ts", ["src/**/foo.ts"])).toBe(false);
});

test("a mention ends at the member-name boundary, and reserved names cannot be groups", () => {
	expect(parseMentions("ask @parser- and @parser-x")).toEqual(["parser-", "parser-x"]);
	const board = new Board();
	const base = {
		kind: "worker" as const,
		status: "waiting" as const,
		phase: "working" as const,
		readCursor: 0,
		fixRounds: 0,
		createdAt: "",
		brief: { task: "", owns: [], avoid: [] },
	};
	for (const group of ["all", "coordinator", "monitor"])
		expect(() => board.add({ ...base, name: `${group}-1`, group })).toThrow("reserved");
});

test("a review counts as approval only when it says APPROVE last", () => {
	expect(reviewVerdict("fine\nVERDICT: APPROVE")).toBe("APPROVE");
	expect(reviewVerdict("VERDICT: APPROVE or VERDICT: CHANGES_REQUESTED")).toBe("CHANGES_REQUESTED");
	expect(reviewVerdict("no verdict here")).toBeUndefined();
});

test("an unreadable manifest is a failed gate, never an empty pass", async () => {
	const dir = tmp("swarm-gates-");
	writeFileSync(join(dir, "package.json"), "{ not json");
	expect(() => detectGates(dir)).toThrow("unreadable");
	const results = await runProjectGates(dir);
	expect(results).toHaveLength(1);
	expect(results[0]?.ok).toBe(false);
});

test("a worker in its own worktree passes ownership, gates and review, then lands", async () => {
	const snapshots: SwarmSnapshot[] = [];
	let coordinatorWakes = 0;
	const swarm = new Swarm(
		{
			title: "Add a",
			gates: ['node -e "process.exit(0)"'],
			review: true,
			isolation: "worktree",
			setup: [],
			maxFixRounds: 3,
		},
		{
			service,
			parentSessionId: parent.sessionId,
			cwd: repo,
			repo,
			worktreeRoot: tmp("swarm-worktrees-"),
			definitions: () => BUILTIN_AGENTS,
			availableModels: () => [{ provider: "faux", id: "faux" }],
			resolveA2A: () => {
				throw new Error("unused");
			},
			notifyCoordinator: () => void coordinatorWakes++,
			isCoordinatorIdle: () => false,
			onChange: (snapshot) => snapshots.push(snapshot),
		},
	);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("write", { path: "src/a.ts", content: "export const a = 1;\n" }),
		),
		fauxAssistantMessage(fauxToolCall("swarm_done", { summary: "added a" })),
		fauxAssistantMessage("Added src/a.ts."),
		fauxAssistantMessage("No material problems.\nVERDICT: APPROVE"),
	]);
	const member = await swarm.addMember({
		name: "alpha",
		brief: { task: "Create src/a.ts", owns: ["src/a.ts"], avoid: [] },
	});
	expect(member.worktree?.branch).toStartWith("swarm/");
	const deadline = Date.now() + 30_000;
	while (member.phase !== "done" && member.phase !== "needs-fixes" && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 50));
	expect(member.phase).toBe("done");
	expect(member.gates?.every((g) => g.ok)).toBe(true);
	expect(member.review?.verdict).toBe("approve");
	expect(member.changedFiles).toEqual(["src/a.ts"]);
	expect(existsSync(join(repo, "src", "a.ts"))).toBe(false);
	const kinds = swarm.board.posts.map((p) => p.kind);
	expect(kinds).toContain("brief");
	expect(kinds).toContain("report");
	expect(swarm.board.posts.at(-1)?.text).toContain("passed");
	expect(coordinatorWakes).toBeGreaterThan(0);
	expect(snapshots.length).toBeGreaterThan(0);
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(member.status).toBe("waiting");

	await swarm.land("alpha");
	expect(readFileSync(join(repo, "src", "a.ts"), "utf8").replace(/\r\n/g, "\n")).toBe(
		"export const a = 1;\n",
	);
	const worktree = member.worktree?.path ?? "";
	await swarm.remove("alpha");
	expect(existsSync(worktree)).toBe(false);
	expect(member.status).toBe("killed");
	await swarm.dispose();
}, 60_000);

test("changed paths are literal, even ones git would quote", async () => {
	const name = "src/é x.ts";
	writeFileSync(join(repo, name), "export {};\n");
	try {
		expect(await changedFiles(repo)).toContain(name);
	} finally {
		rmSync(join(repo, name), { force: true });
	}
});

test("swarms with the same long title get distinct worktrees", async () => {
	const root = tmp("swarm-long-titles-");
	const title = "a very long swarm title that certainly exceeds the forty character slug limit";
	const first = await createWorktree({
		repo,
		root,
		swarm: title,
		swarmId: "aaaa1111",
		member: "w",
	});
	const second = await createWorktree({
		repo,
		root,
		swarm: title,
		swarmId: "bbbb2222",
		member: "w",
	});
	try {
		expect(first.path).not.toBe(second.path);
		expect(first.branch).not.toBe(second.branch);
	} finally {
		await removeWorktree(first, { deleteBranch: true });
		await removeWorktree(second, { deleteBranch: true });
	}
});
