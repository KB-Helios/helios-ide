import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createDelegationService, type DelegationService } from "pi-delegation";
import { BUILTIN_AGENTS } from "pi-subagents";
import type { Member, Post } from "./board.ts";
import { createWorktree, GIT_ENV, removeWorktree } from "./git.ts";
import { swarmMemberExtension } from "./memberExtension.ts";
import {
	createFileSwarmStore,
	parseSwarmState,
	SWARM_STATE_VERSION,
	type SwarmState,
	setSwarmWriteSeamForTests,
} from "./store.ts";
import { Swarm, type SwarmDeps } from "./swarm.ts";

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
const until = async (condition: () => boolean, ms = 30_000) => {
	const deadline = Date.now() + ms;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
	expect(condition()).toBe(true);
};

let runtime: ModelRuntime;
let parent: AgentSession;
let repo: string;
let service: DelegationService;
const priorAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(async () => {
	process.env.PI_CODING_AGENT_DIR = tmp("swarm-store-agentdir-");
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
	repo = tmp("swarm-store-repo-");
	git(repo, "init", "-q", "-b", "main");
	git(repo, "config", "user.email", "t@t");
	git(repo, "config", "user.name", "t");
	writeFileSync(join(repo, "README.md"), "hi\n");
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
		delegationRoot: tmp("swarm-store-delegation-"),
		scope: "test",
		modelRuntime: runtime,
		childExtensionFactories: [swarmMemberExtension],
	});
});

afterAll(() => {
	setSwarmWriteSeamForTests(undefined);
	parent?.dispose();
	if (priorAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = priorAgentDir;
	for (const dir of dirs)
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {}
});

const config = {
	title: "Persist",
	gates: [],
	review: false,
	isolation: "worktree" as const,
	setup: [],
	maxFixRounds: 3,
};

function deps(overrides: Partial<SwarmDeps> = {}): SwarmDeps {
	return {
		service,
		parentSessionId: parent.sessionId,
		cwd: repo,
		repo,
		worktreeRoot: tmp("swarm-store-worktrees-"),
		definitions: () => BUILTIN_AGENTS,
		availableModels: () => [{ provider: "faux", id: "faux" }],
		resolveA2A: () => {
			throw new Error("unused");
		},
		notifyCoordinator: () => {},
		isCoordinatorIdle: () => true,
		onChange: () => {},
		...overrides,
	};
}

function member(name: string, overrides: Partial<Member> = {}): Member {
	return {
		name,
		kind: "worker",
		status: "waiting",
		phase: "working",
		brief: { task: `Do ${name}`, owns: [`src/${name}/`], avoid: ["docs/"] },
		readCursor: 0,
		fixRounds: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function posts(count: number): Post[] {
	return Array.from({ length: count }, (_, i) => ({
		seq: i + 1,
		from: "coordinator",
		to: [],
		kind: "system" as const,
		text: `post ${i + 1}`,
		at: "2026-01-01T00:00:00.000Z",
	}));
}

function stateOf(members: Member[], overrides: Partial<SwarmState> = {}): SwarmState {
	return {
		version: SWARM_STATE_VERSION,
		id: "11111111-1111-1111-1111-111111111111",
		parentSessionId: parent.sessionId,
		title: "Persist",
		status: "running",
		createdAt: "2026-01-01T00:00:00.000Z",
		savedAt: "2026-01-01T00:00:00.000Z",
		config,
		members,
		posts: posts(3),
		coordinatorCursor: 1,
		...overrides,
	};
}

test("a board survives a save and load unchanged, with no temp file left behind", async () => {
	const dir = tmp("swarm-store-roundtrip-");
	const file = join(dir, "nested", "board.json");
	const store = createFileSwarmStore(file);
	expect(store.load()).toEqual({ kind: "missing" });
	const swarm = new Swarm({ ...config, isolation: "shared" }, deps({ store }));
	swarm.post("coordinator", "hello board", "message", []);
	await Promise.resolve();
	const loaded = store.load();
	expect(loaded.kind).toBe("ok");
	if (loaded.kind !== "ok") return;
	expect(loaded.state.posts.map((p) => p.text)).toEqual([
		'Swarm "Persist" started.',
		"hello board",
	]);
	expect({ ...loaded.state, savedAt: "" }).toEqual({ ...swarm.state(), savedAt: "" });
	expect(readdirSync(join(dir, "nested")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	store.clear();
	expect(store.load()).toEqual({ kind: "missing" });
	await swarm.dispose();
});

test("a write that stops before the rename leaves the previous board readable", () => {
	const dir = tmp("swarm-store-atomic-");
	const file = join(dir, "board.json");
	const store = createFileSwarmStore(file);
	store.save(stateOf([member("alpha")]));
	setSwarmWriteSeamForTests(() => {
		throw new Error("host stopped");
	});
	try {
		expect(() => store.save(stateOf([member("alpha"), member("beta")]))).toThrow("host stopped");
	} finally {
		setSwarmWriteSeamForTests(undefined);
	}
	const loaded = store.load();
	expect(loaded.kind === "ok" && loaded.state.members.map((m) => m.name)).toEqual(["alpha"]);
	expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
});

test("a failing store never stops the swarm, and the next change retries", async () => {
	const errors: unknown[] = [];
	let broken = true;
	const saved: SwarmState[] = [];
	const swarm = new Swarm(
		{ ...config, isolation: "shared" },
		deps({
			store: {
				load: () => ({ kind: "missing" }),
				save: (state) => {
					if (broken) throw new Error("disk full");
					saved.push(state);
				},
				clear: () => {},
			},
			onStoreError: (error) => errors.push(error),
		}),
	);
	await Promise.resolve();
	expect(errors).toHaveLength(1);
	broken = false;
	swarm.post("coordinator", "still alive", "message", []);
	await Promise.resolve();
	expect(saved.at(-1)?.posts.map((p) => p.text)).toContain("still alive");
	await swarm.dispose();
});

test("a corrupt, partial or unsupported board file reads as corrupt and is kept aside", () => {
	const dir = tmp("swarm-store-corrupt-");
	const good = JSON.stringify(stateOf([member("alpha")]));
	const cases: Record<string, string> = {
		truncated: good.slice(0, Math.floor(good.length / 2)),
		garbage: "\u0000\u0001 not json",
		array: "[]",
		"wrong version": JSON.stringify({ ...JSON.parse(good), version: 99 }),
		"bad member": JSON.stringify({ ...JSON.parse(good), members: [{ name: "Bad Name" }] }),
		"bad post order": JSON.stringify({
			...JSON.parse(good),
			posts: posts(3).map((p) => ({ ...p, seq: 7 })),
		}),
		"cursor past the board": JSON.stringify({ ...JSON.parse(good), coordinatorCursor: 9 }),
		"duplicate members": JSON.stringify({
			...JSON.parse(good),
			members: [member("alpha"), member("alpha")],
		}),
	};
	for (const [label, text] of Object.entries(cases)) {
		const file = join(dir, `${label.replace(/ /g, "-")}.json`);
		writeFileSync(file, text);
		const loaded = createFileSwarmStore(file).load();
		expect(loaded.kind, label).toBe("corrupt");
		expect(existsSync(file), label).toBe(false);
		expect(existsSync(`${file}.corrupt`), label).toBe(true);
		expect(createFileSwarmStore(file).load(), label).toEqual({ kind: "missing" });
	}
	expect(() => parseSwarmState(good)).not.toThrow();
});

test("a restored board is paused: no member starts, a vanished worktree is marked", async () => {
	const root = tmp("swarm-store-restore-");
	const alpha = await createWorktree({
		repo,
		root,
		swarm: "Persist",
		swarmId: "r1",
		member: "alpha",
	});
	writeFileSync(join(alpha.path, "unfinished.txt"), "work in progress\n");
	const beta = await createWorktree({
		repo,
		root,
		swarm: "Persist",
		swarmId: "r1",
		member: "beta",
	});
	const gamma = await createWorktree({
		repo,
		root,
		swarm: "Persist",
		swarmId: "r1",
		member: "gamma",
	});
	rmSync(beta.path, { recursive: true, force: true });
	const stored = stateOf([
		member("alpha", {
			status: "active",
			phase: "gating",
			activity: "running quality gates",
			doneClaim: "claimed",
			worktree: { path: alpha.path, branch: alpha.branch, base: alpha.base },
			childSessionId: "dead-child",
		}),
		member("beta", { worktree: { path: beta.path, branch: beta.branch, base: beta.base } }),
		member("gamma", {
			phase: "done",
			landed: true,
			worktree: { path: gamma.path, branch: gamma.branch, base: gamma.base },
		}),
		member("delta", { status: "killed" }),
		member("scout", { kind: "scout", phase: "working" }),
	]);
	const store = createFileSwarmStore(join(tmp("swarm-store-restore-file-"), "board.json"));
	store.save(stored);

	let coordinatorWakes = 0;
	const loaded = store.load();
	if (loaded.kind !== "ok") throw new Error("expected a board");
	const swarm = Swarm.restore(
		loaded.state,
		deps({
			store,
			monitorDelayMs: 20,
			notifyCoordinator: () => void coordinatorWakes++,
			worktreeRoot: root,
		}),
	);
	faux.setResponses([fauxAssistantMessage("must never run")]);
	await new Promise((r) => setTimeout(r, 250));

	expect(swarm.id).toBe(stored.id);
	expect(swarm.title).toBe("Persist");
	expect(swarm.board.coordinatorCursor).toBe(1);
	const a = swarm.board.require("alpha");
	expect(a.status).toBe("paused");
	expect(a.restored).toBe(true);
	expect(a.phase).toBe("working");
	expect(a.activity).toBeUndefined();
	expect(a.doneClaim).toBeUndefined();
	expect(a.brief.owns).toEqual(["src/alpha/"]);
	expect(a.error).toContain("swarm_resume");
	const b = swarm.board.require("beta");
	expect(b.status).toBe("paused");
	expect(b.worktreeMissing).toBe(true);
	expect(b.error).toContain("no longer exists");
	const g = swarm.board.require("gamma");
	expect(g.phase).toBe("done");
	expect(g.landed).toBe(true);
	expect(g.error).toBeUndefined();
	expect(swarm.board.require("delta").status).toBe("killed");
	expect(swarm.board.require("delta").restored).toBeUndefined();
	expect(swarm.board.require("scout").restored).toBe(true);

	// Nothing started by itself: no child session, no model call, no wake, no monitor post.
	expect(service.childrenOf(parent.sessionId)).toEqual([]);
	expect(faux.getPendingResponseCount()).toBe(1);
	expect(coordinatorWakes).toBe(0);
	expect(swarm.board.posts).toHaveLength(4);
	expect(swarm.board.posts.at(-1)?.text).toContain("Restored after a host restart");
	expect(swarm.restoredMembers().map((m) => m.name)).toEqual(["alpha", "beta", "gamma", "scout"]);

	// A post to a paused member waits unread; it is not delivered to a session that does not exist.
	swarm.post("coordinator", "@alpha use the new API", "message", []);
	await new Promise((r) => setTimeout(r, 50));
	expect(swarm.board.require("alpha").readCursor).toBe(0);
	expect(service.childrenOf(parent.sessionId)).toEqual([]);

	// The stored board was refreshed by the restore and by the post.
	const after = store.load();
	expect(after.kind === "ok" && after.state.members.find((m) => m.name === "alpha")?.status).toBe(
		"paused",
	);

	await expect(swarm.resume("beta")).rejects.toThrow("no longer exists");

	let prompt = "";
	faux.setResponses([
		(context) => {
			prompt = JSON.stringify(context.messages);
			return fauxAssistantMessage("Picked up where I left off.");
		},
	]);
	const worktreesBefore = git(repo, "worktree", "list").trim().split("\n").length;
	await swarm.resume("alpha");
	await until(() => swarm.board.require("alpha").status === "waiting");
	const resumed = swarm.board.require("alpha");
	expect(resumed.restored).toBeUndefined();
	expect(resumed.worktree?.path).toBe(alpha.path);
	expect(readFileSync(join(alpha.path, "unfinished.txt"), "utf8")).toBe("work in progress\n");
	expect(git(repo, "worktree", "list").trim().split("\n")).toHaveLength(worktreesBefore);
	expect(prompt).toContain("host restarted");
	expect(prompt).toContain("use the new API");
	expect(swarm.board.posts.some((p) => p.from === "alpha" && p.kind === "report")).toBe(true);
	expect(service.childrenOf(parent.sessionId)).toHaveLength(1);
	// The members that were not resumed stay paused.
	expect(swarm.board.require("scout").status).toBe("paused");

	// A member whose worktree is gone can still be removed.
	await swarm.remove("beta", true);
	expect(swarm.board.require("beta").status).toBe("killed");

	await swarm.dispose();
	const final = store.load();
	expect(final.kind === "ok" && final.state.members.find((m) => m.name === "beta")?.status).toBe(
		"killed",
	);
	await removeWorktree({ ...alpha, repo }, { deleteBranch: true });
	await removeWorktree({ ...gamma, repo }, { deleteBranch: true });
}, 60_000);

test("a restored shared-tree member is re-attached without a worktree", async () => {
	mkdirSync(join(repo, "src"), { recursive: true });
	const stored = stateOf(
		[member("scout", { kind: "scout", brief: { task: "Look", owns: [], avoid: [] } })],
		{
			config: { ...config, isolation: "shared" },
		},
	);
	const swarm = Swarm.restore(stored, deps());
	faux.setResponses([fauxAssistantMessage("Nothing found.")]);
	await swarm.resume("scout");
	await until(() => swarm.board.require("scout").status === "waiting");
	expect(swarm.board.require("scout").worktree).toBeUndefined();
	await swarm.dispose();
});
