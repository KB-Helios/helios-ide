import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

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
import {
	createFauxCore,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DagClient, DagResult, DagSnapshot } from "pi-dag";
import { closeAllDags, dagServiceFor, factoryWorktreeRoot } from "../dag";
import { registerGateGuard } from "./gateGuard";
import { runFactoryGates } from "./gateTools";
import {
	buildFactoryDefinition,
	FactoryRun,
	factoryInspector,
	isReleaseApprovedByHuman,
	landFactory,
	parseFactoryNode,
} from "./index";

const model = { provider: "factory-faux", id: "worker" };
const faux = createFauxCore({
	provider: model.provider,
	api: "factory-faux",
	tokensPerSecond: 100_000,
});
const root = mkdtempSync(join(tmpdir(), "trfactory-"));
let runtime: ModelRuntime;
let priorDataDir: string | undefined;
let priorAgentDir: string | undefined;
let priorOffline: string | undefined;
let serial = 0;

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

/** A repo whose only gate is a `test` script (a bun.lock makes the detected command `bun run test`). */
const PASSING_GATE = 'bun -e "process.exit(0)"';
/** A gate that fails while `bad.txt` says "bad", so a coder can break and then fix it. */
const BAD_FILE_GATE =
	"bun -e \"const fs = require('fs'); process.exit(fs.existsSync('bad.txt') && fs.readFileSync('bad.txt', 'utf8').includes('bad') ? 1 : 0)\"";

function makeRepo(gate = PASSING_GATE): string {
	const repo = join(root, `repo${serial++}`);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "T");
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ name: "demo", scripts: { test: gate } }),
	);
	writeFileSync(join(repo, "bun.lock"), "");
	writeFileSync(join(repo, "README.md"), "demo\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	return repo;
}

beforeAll(async () => {
	priorDataDir = process.env.THINKRAIL_DATA_DIR;
	priorAgentDir = process.env.PI_CODING_AGENT_DIR;
	priorOffline = process.env.PI_OFFLINE;
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider(model.provider, {
		api: faux.api,
		baseUrl: "http://faux.local",
		apiKey: "synthetic",
		streamSimple: faux.streamSimple,
		models: [
			{
				id: model.id,
				name: "Worker",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	});
});

afterEach(async () => {
	await closeAllDags();
});

afterAll(() => {
	for (const [key, prior] of [
		["THINKRAIL_DATA_DIR", priorDataDir],
		["PI_CODING_AGENT_DIR", priorAgentDir],
		["PI_OFFLINE", priorOffline],
	] as const) {
		if (prior === undefined) delete process.env[key];
		else process.env[key] = prior;
	}
	rmSync(root, { recursive: true, force: true });
});

function value<T>(result: DagResult<T>): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

function bind(
	workspaceId: string,
	repo: string,
	caller: "owner" | "human",
	trusted = true,
): DagClient {
	return dagServiceFor(workspaceId).bind({
		caller:
			caller === "owner"
				? { kind: "owner", ownerId: "host" }
				: { kind: "human", operatorId: "thinkrail-ui" },
		signal: new AbortController().signal,
		execution: {
			kind: "runtime",
			modelRuntime: runtime,
			cwd: repo,
			model,
			...(trusted ? { isProjectTrusted: () => true } : {}),
		},
	});
}

async function until(
	client: DagClient,
	dagId: string,
	predicate: (snapshot: DagSnapshot) => boolean,
): Promise<DagSnapshot> {
	let last: DagSnapshot | undefined;
	for (let n = 0; n < 4000; n++) {
		last = value(await client.getDag({ dagId }));
		if (predicate(last)) return last;
		await Bun.sleep(10);
	}
	throw new Error(
		`DAG did not settle: ${JSON.stringify(last?.nodes.map((n) => [n.id, n.status]))}`,
	);
}

const lf = (text: string) => text.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));

function textOf(context: unknown): string {
	return JSON.stringify(context);
}

function submit(port: string, text: string) {
	return fauxAssistantMessage(
		fauxToolCall("dag_submit_result", { outputs: { [port]: { kind: "text", text } } }),
	);
}

test("two coders run in parallel worktrees, pass gates and land only after a human approves", async () => {
	const workspaceId = `factoryws${serial++}`;
	const repo = makeRepo();
	const toolCalls: string[] = [];
	let arrived = 0;
	let open!: () => void;
	const bothStarted = new Promise<void>((resolve) => {
		open = resolve;
	});

	const respond: FauxResponseFactory = async (context) => {
		const seen = textOf(context);
		const turn = context.messages.filter((message) => message.role === "assistant").length;
		const call = (name: string, args: Record<string, string>) => {
			toolCalls.push(name);
			return fauxAssistantMessage(fauxToolCall(name, args));
		};
		const coder = /"role\\":\\"coder\\".*?src\/(a|b)\/\*\*/.exec(seen)?.[1];
		if (coder) {
			if (turn === 0) {
				// Both coders must be alive at once or this barrier never opens.
				if (++arrived === 2) open();
				await bothStarted;
				return call("factory_write", {
					path: `src/${coder === "a" ? "b" : "a"}/evil.txt`,
					content: "x",
				});
			}
			if (turn === 1)
				return call("factory_write", {
					path: `src/${coder}/feature.txt`,
					content: `feature ${coder}\n`,
				});
			if (turn === 2) return call("factory_run_gates", {});
			return submit("summary", `coder ${coder} done`);
		}
		const gateOf = /"role\\":\\"gate\\"/.test(seen);
		if (gateOf) return turn === 0 ? call("factory_run_gates", {}) : submit("report", "gates ok");
		if (/"role\\":\\"release\\"/.test(seen))
			return turn === 0
				? call("factory_diff", {})
				: turn === 1
					? call("factory_report", {})
					: submit("summary", "ready to land");
		if (/"role\\":\\"land\\"/.test(seen))
			return turn === 0 ? call("factory_land", {}) : submit("landed", "landed");
		throw new Error(`Unscripted node: ${seen.slice(0, 200)}`);
	};
	faux.setResponses(Array.from({ length: 40 }, () => respond));

	const definition = buildFactoryDefinition({
		title: "Two features",
		target: "main",
		coders: [
			{ id: "coder-a", task: "Add feature a", owns: ["src/a/**"] },
			{ id: "coder-b", task: "Add feature b", owns: ["src/b/**"] },
		],
	});
	const owner = bind(workspaceId, repo, "owner");
	const { dagId } = value(
		await owner.execute({ commandId: "create", command: { kind: "create", definition } }),
	);
	const created = value(await owner.getDag({ dagId }));
	value(
		await owner.execute({
			commandId: "resume",
			dagId,
			expectedVersion: created.version,
			command: { kind: "resume" },
		}),
	);

	const waiting = await until(owner, dagId, (state) =>
		state.gates.some((gate) => gate.disposition === "pending"),
	);
	// Before the human decides: everything but the landing has run, and nothing is on main.
	const status = Object.fromEntries(waiting.nodes.map((node) => [node.id, node.status]));
	expect(status["coder-a"]).toBe("completed");
	expect(status["coder-b"]).toBe("completed");
	expect(status["gate-coder-a"]).toBe("completed");
	expect(status["gate-coder-b"]).toBe("completed");
	expect(status.release).toBe("waiting-approval");
	expect(status.land).toBe("pending");
	expect(toolCalls).not.toContain("factory_land");
	expect(toolCalls).toContain("factory_diff");
	expect(existsSync(join(repo, "src", "a", "feature.txt"))).toBe(false);
	expect(git(repo, "log", "--oneline").trim().split("\n")).toHaveLength(1);
	expect(await isReleaseApprovedByHuman(dagServiceFor(workspaceId), dagId, "release")).toBe(false);

	const worktrees = readdirSync(factoryWorktreeRoot(workspaceId)).filter((name) =>
		name.startsWith("factory-"),
	);
	expect(worktrees).toHaveLength(1);
	const base = join(factoryWorktreeRoot(workspaceId), worktrees[0] ?? "");
	expect(readFileSync(join(base, "coder-a", "src", "a", "feature.txt"), "utf8")).toBe(
		"feature a\n",
	);
	expect(readFileSync(join(base, "coder-b", "src", "b", "feature.txt"), "utf8")).toBe(
		"feature b\n",
	);
	// A coder cannot write into the other's territory: the ownership refusal left no file behind.
	expect(existsSync(join(base, "coder-a", "src", "b", "evil.txt"))).toBe(false);
	expect(existsSync(join(base, "coder-b", "src", "a", "evil.txt"))).toBe(false);

	// A chat controller can never approve a human-only release.
	const gate = waiting.gates.find((item) => item.disposition === "pending");
	const refused = await dagServiceFor(workspaceId)
		.bind({
			caller: { kind: "controller", sessionId: "chat" },
			signal: new AbortController().signal,
		})
		.execute({
			commandId: "chat-approve",
			dagId,
			expectedVersion: waiting.version,
			command: { kind: "approve", gateId: gate?.id ?? "", reason: "yes" },
		});
	expect(refused.ok).toBe(false);
	expect(toolCalls).not.toContain("factory_land");

	value(
		await bind(workspaceId, repo, "human").execute({
			commandId: "human-approve",
			dagId,
			expectedVersion: waiting.version,
			command: { kind: "approve", gateId: gate?.id ?? "", reason: "Looks good" },
		}),
	);
	const settled = await until(owner, dagId, (state) =>
		state.nodes.every((node) => node.status === "completed"),
	);
	expect(settled.nodes).toHaveLength(6);
	expect(toolCalls.filter((name) => name === "factory_land")).toHaveLength(1);
	expect(await isReleaseApprovedByHuman(dagServiceFor(workspaceId), dagId, "release")).toBe(true);

	expect(lf(readFileSync(join(repo, "src", "a", "feature.txt"), "utf8"))).toBe("feature a\n");
	expect(lf(readFileSync(join(repo, "src", "b", "feature.txt"), "utf8"))).toBe("feature b\n");
	const log = git(repo, "log", "--format=%s");
	expect(log).toContain("factory: land coder-a");
	expect(log).toContain("factory: land coder-b");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
	expect(existsSync(join(base, "coder-a"))).toBe(false);
	expect(existsSync(join(base, "coder-b"))).toBe(false);
	expect(git(repo, "branch", "--list", "swarm/*").trim()).toBe("");
}, 120_000);

function unitRun(
	repo: string,
	options: { trusted: boolean; approved?: boolean } = { trusted: true },
) {
	return new FactoryRun({
		workspaceId: "unit",
		dagId: `unit-${serial++}`,
		cwd: repo,
		worktreeRoot: join(root, `unit-worktrees-${serial++}`),
		isTrusted: () => options.trusted,
		releaseApproved: async () => options.approved ?? false,
	});
}

test("landing is refused without a human release, and nothing changes", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: false });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	await expect(
		landFactory(run, { sources: ["coder-a"], release: "release", target: "main" }),
	).rejects.toThrow("no human approval");
	expect(existsSync(join(repo, "src", "a", "x.txt"))).toBe(false);
	expect(existsSync(meta.path)).toBe(true);
});

test("landing also needs a fresh passing gate record and the target branch", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	const plan = { sources: ["coder-a"], release: "release", target: "main" };
	await expect(landFactory(run, plan)).rejects.toThrow("no fresh passing gate record");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "changed after the gates\n");
	await expect(landFactory(run, plan)).rejects.toThrow("no fresh passing gate record");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	await expect(landFactory(run, { ...plan, target: "release-branch" })).rejects.toThrow(
		"not the target",
	);
	expect(await landFactory(run, plan)).toMatchObject([{ node: "coder-a", status: "landed" }]);
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe(
		"changed after the gates\n",
	);
	expect(existsSync(meta.path)).toBe(false);
});

test("a landing retried after a failed merge lands the committed source instead of dropping it", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "from the coder\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	const plan = { sources: ["coder-a"], release: "release", target: "main" };

	// A conflicting commit on the target makes the first merge fail; it is aborted cleanly.
	mkdirSync(join(repo, "src", "a"), { recursive: true });
	writeFileSync(join(repo, "src", "a", "x.txt"), "from main\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "conflict");
	await expect(landFactory(run, plan)).rejects.toThrow("failed and was aborted");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
	expect(run.readMeta("coder-a")?.committed).toBeTruthy();

	// An edit after the landing commit is never landed unchecked.
	writeFileSync(join(meta.path, "src", "a", "y.txt"), "late\n");
	await expect(landFactory(run, plan)).rejects.toThrow("changed after its landing commit");
	rmSync(join(meta.path, "src", "a", "y.txt"));

	// Once the conflict is gone, the retry merges the recorded commit; nothing is reported as unchanged.
	git(repo, "reset", "--hard", "HEAD~1");
	expect(await landFactory(run, plan)).toMatchObject([{ node: "coder-a", status: "landed" }]);
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe("from the coder\n");
	expect(git(repo, "log", "--format=%s")).toContain("factory: land coder-a");
	expect(existsSync(meta.path)).toBe(false);
});

test("an untrusted project never runs its gates", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: false, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	// A gate that would leave evidence if it ran.
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	const record = await runFactoryGates(run, meta);
	expect(record).toMatchObject({ ok: false, commands: [], results: [] });
	expect(record.reason).toContain("not trusted");
	await expect(
		landFactory(run, { sources: ["coder-a"], release: "release", target: "main" }),
	).rejects.toThrow("no fresh passing gate record");
});

test("an ownership violation fails the gates, including a changed build manifest", async () => {
	const repo = makeRepo();
	const run = unitRun(repo);
	const meta = await run.ensureWorktree("coder-a", {
		owns: ["src/a/**"],
		avoid: ["src/a/secret/**"],
	});
	mkdirSync(join(meta.path, "src", "a", "secret"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "ok.txt"), "ok\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);

	writeFileSync(join(meta.path, "src", "a", "secret", "key.txt"), "no\n");
	let record = await runFactoryGates(run, meta);
	expect(record.ok).toBe(false);
	expect(record.violations).toEqual(["src/a/secret/key.txt"]);
	rmSync(join(meta.path, "src", "a", "secret"), { recursive: true });

	writeFileSync(join(meta.path, "outside.txt"), "no\n");
	record = await runFactoryGates(run, meta);
	expect(record.violations).toEqual(["outside.txt"]);
	rmSync(join(meta.path, "outside.txt"));

	// With unrestricted ownership a manifest is still protected, since it decides what gates execute.
	const open = await unitRun(repo).ensureWorktree("free", { owns: [], avoid: [] });
	writeFileSync(
		join(open.path, "package.json"),
		JSON.stringify({ scripts: { test: "echo pwned > pwned.txt" } }),
	);
	const poisoned = await runFactoryGates(unitRun(repo), open);
	expect(poisoned.ok).toBe(false);
	expect(poisoned.violations).toEqual(["package.json"]);
	expect(existsSync(join(open.path, "pwned.txt"))).toBe(false);
});

test("the factory template validates ownership and exposes a hook before the release", () => {
	expect(() =>
		buildFactoryDefinition({
			title: "t",
			target: "main",
			coders: [
				{ id: "a", task: "x", owns: ["src/**"] },
				{ id: "b", task: "y", owns: ["src/b/**"] },
			],
		}),
	).toThrow("may touch the same files");
	expect(() =>
		buildFactoryDefinition({
			title: "t",
			target: "main",
			coders: [
				{ id: "a", task: "x", owns: ["src/a/**"] },
				{ id: "b", task: "y" },
			],
		}),
	).toThrow("needs owns");

	const definition = buildFactoryDefinition({
		title: "t",
		target: "main",
		coders: [{ id: "a", task: "x" }],
		beforeRelease: ({ gates, release, gateOutput }) => ({
			nodes: [
				{
					id: "review",
					task: "review",
					inputs: { gate: { kind: "text" } },
					outputs: { findings: { kind: "text" } },
				},
			],
			connections: [
				{
					id: "gate-to-review",
					kind: "data",
					from: { nodeId: gates[0] ?? "", output: gateOutput },
					to: { nodeId: "review", input: "gate" },
				},
				{
					id: "review-to-release",
					kind: "data",
					from: { nodeId: "review", output: "findings" },
					to: { nodeId: release, input: "review" },
				},
			],
			releaseInputs: { review: { kind: "text" } },
		}),
	});
	expect(definition.nodes.map((node) => node.id)).toEqual([
		"a",
		"gate-a",
		"review",
		"release",
		"land",
	]);
	const release = definition.nodes.find((node) => node.id === "release");
	expect(release?.approval?.authority).toBe("human");
	expect(Object.keys(release?.inputs ?? {})).toEqual(["gate-a", "review"]);
	const prompt = definition.nodes.find((node) => node.id === "a")?.session?.systemPrompt;
	expect(parseFactoryNode(prompt)).toEqual({ role: "coder", owns: [], avoid: [], retries: 2 });
	expect(factoryInspector(["a"]).tools).toEqual([
		"factory_read",
		"factory_list",
		"factory_report",
		"factory_diff",
	]);
	expect(parseFactoryNode(factoryInspector(["a"]).systemPromptSuffix)).toEqual({
		role: "inspector",
		sources: ["a"],
	});
	// No coder holds a raw write tool; only factory_* tools exist for factory nodes.
	for (const node of definition.nodes)
		for (const tool of node.session?.tools ?? []) expect(tool).toStartWith("factory_");
});

test("a coder whose gates fail is sent back with the failing report, bounded, and passes on the fix", async () => {
	const workspaceId = `factoryws${serial++}`;
	const repo = makeRepo(BAD_FILE_GATE);
	const seenByCoder: string[] = [];
	const respond: FauxResponseFactory = (context) => {
		const seen = textOf(context);
		const turn = context.messages.filter((message) => message.role === "assistant").length;
		if (/"role\\":\\"coder\\"/.test(seen)) {
			seenByCoder.push(seen);
			if (turn === 0)
				return fauxAssistantMessage(
					fauxToolCall("factory_write", { path: "bad.txt", content: "bad\n" }),
				);
			if (turn === 1) return submit("summary", "first try");
			if (turn === 2)
				return fauxAssistantMessage(
					fauxToolCall("factory_write", { path: "bad.txt", content: "good\n" }),
				);
			return submit("summary", "second try");
		}
		return submit("report", "n/a");
	};
	faux.setResponses(Array.from({ length: 12 }, () => respond));

	const definition = buildFactoryDefinition({
		title: "Gate retry",
		target: "main",
		coders: [{ id: "coder-a", task: "Add the file" }],
	});
	const owner = bind(workspaceId, repo, "owner");
	const { dagId } = value(
		await owner.execute({ commandId: "create", command: { kind: "create", definition } }),
	);
	const created = value(await owner.getDag({ dagId }));
	value(
		await owner.execute({
			commandId: "resume",
			dagId,
			expectedVersion: created.version,
			command: { kind: "resume" },
		}),
	);
	const done = await until(
		owner,
		dagId,
		(state) => state.nodes.find((node) => node.id === "coder-a")?.status === "completed",
	);
	expect(done.nodes.find((node) => node.id === "coder-a")?.attempt).toBe(1);

	// The refusal carried the host's failing report to the same coder, and the second submit went through.
	const afterRefusal = seenByCoder.find((seen) => seen.includes("correction 1 of 2"));
	expect(afterRefusal).toBeDefined();
	expect(afterRefusal).toContain("FAIL");
	expect(afterRefusal).toContain("The project's gates failed");
	const meta = join(factoryWorktreeRoot(workspaceId), ".meta");
	const record = JSON.parse(
		readFileSync(join(meta, readdirSync(meta)[0] ?? "", "coder-a.gates.json"), "utf8"),
	);
	expect(record.ok).toBe(true);
}, 120_000);

function guardHandler(run: FactoryRun) {
	type Handler = (
		event: unknown,
		ctx: unknown,
	) => Promise<{ block?: boolean; reason?: string } | undefined>;
	let handler: Handler | undefined;
	registerGateGuard(
		{
			on: (name: string, fn: Handler) => {
				if (name === "tool_call") handler = fn;
			},
		} as never,
		run,
	);
	return (tool: string, sessionId: string) =>
		(handler as Handler)(
			{ type: "tool_call", toolName: tool, toolCallId: "t", input: {} },
			{ sessionManager: { getSessionId: () => sessionId }, signal: undefined },
		);
}

test("the gate guard grants at most the planned corrections per attempt and never loops", async () => {
	const repo = makeRepo(BAD_FILE_GATE);
	const run = unitRun(repo);
	const node = { owns: [], avoid: [], retries: 2 };
	const meta = await run.ensureWorktree("coder-a", node);
	writeFileSync(join(meta.path, "bad.txt"), "bad\n");
	run.bind("session-1", { nodeId: "coder-a", node: { role: "coder", ...node } });
	const submitTool = guardHandler(run);

	expect(await submitTool("factory_read", "session-1")).toBeUndefined();
	const first = await submitTool("dag_submit_result", "session-1");
	expect(first?.block).toBe(true);
	expect(first?.reason).toContain("correction 1 of 2");
	expect(first?.reason).toContain("FAIL");
	const second = await submitTool("dag_submit_result", "session-1");
	expect(second?.reason).toContain("correction 2 of 2");
	expect(second?.reason).toContain("last correction");
	// Budget spent: the third submit goes through with the failure on record.
	expect(await submitTool("dag_submit_result", "session-1")).toBeUndefined();
	expect(run.readGateRecord("coder-a")?.ok).toBe(false);
	expect(run.gateRetriesUsed("coder-a", "session-1")).toBe(2);

	// A human retry is a new attempt and session: it starts with a fresh budget, still bounded.
	run.bind("session-2", { nodeId: "coder-a", node: { role: "coder", ...node } });
	expect((await submitTool("dag_submit_result", "session-2"))?.reason).toContain(
		"correction 1 of 2",
	);

	// The fix passes the host's own gates and nothing is held back.
	writeFileSync(join(meta.path, "bad.txt"), "good\n");
	expect(await submitTool("dag_submit_result", "session-2")).toBeUndefined();
	expect(run.readGateRecord("coder-a")?.ok).toBe(true);
});

test("the gate guard stays out of the way when there is nothing a coder can fix", async () => {
	const repo = makeRepo(BAD_FILE_GATE);
	// An untrusted project never runs gates, so a refusal could only waste the budget.
	const untrusted = unitRun(repo, { trusted: false });
	const node = { owns: [], avoid: [], retries: 2 };
	const meta = await untrusted.ensureWorktree("coder-a", node);
	writeFileSync(join(meta.path, "bad.txt"), "bad\n");
	untrusted.bind("s", { nodeId: "coder-a", node: { role: "coder", ...node } });
	expect(await guardHandler(untrusted)("dag_submit_result", "s")).toBeUndefined();
	expect(untrusted.gateRetriesUsed("coder-a", "s")).toBe(0);

	// retries: 0 and nodes planned before the budget existed are never gated; other roles are ignored.
	const trusted = unitRun(repo);
	const free = await trusted.ensureWorktree("free", { owns: [], avoid: [] });
	writeFileSync(join(free.path, "bad.txt"), "bad\n");
	trusted.bind("zero", {
		nodeId: "free",
		node: { role: "coder", owns: [], avoid: [], retries: 0 },
	});
	trusted.bind("old", { nodeId: "free", node: { role: "coder", owns: [], avoid: [] } });
	trusted.bind("gate", { nodeId: "gate-free", node: { role: "gate", source: "free" } });
	const submitTool = guardHandler(trusted);
	for (const session of ["zero", "old", "gate", "unbound"])
		expect(await submitTool("dag_submit_result", session)).toBeUndefined();
	expect(trusted.readGateRecord("free")).toBeUndefined();
});

test("the template writes a bounded, validated correction budget into every coder", () => {
	const budget = (gateRetries?: number) =>
		parseFactoryNode(
			buildFactoryDefinition({
				title: "t",
				target: "main",
				coders: [{ id: "a", task: "x" }],
				...(gateRetries === undefined ? {} : { gateRetries }),
			}).nodes.find((node) => node.id === "a")?.session?.systemPrompt,
		);
	expect(budget()).toMatchObject({ retries: 2 });
	expect(budget(0)).toMatchObject({ retries: 0 });
	expect(budget(5)).toMatchObject({ retries: 5 });
	for (const bad of [-1, 6, 1.5, Number.NaN])
		expect(() => budget(bad)).toThrow("gateRetries must be a whole number");
});
