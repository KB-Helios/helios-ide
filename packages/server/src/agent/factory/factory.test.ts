import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(60_000);

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
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
import { runFactoryGates, sourceStatus } from "./gateTools";
import {
	buildFactoryDefinition,
	encodeFactoryNode,
	FactoryRun,
	factoryInspector,
	isReleaseApprovedByHuman,
	landFactory,
	parseFactoryNode,
} from "./index";
import { runIntegrationGates } from "./integrationTools";
import { landOnTarget } from "./landTools";
import { confinedPath, setRecordWriteSeamForTests, writeAtomically } from "./run";
import { setDefaultGateSandbox } from "./sandbox";
import { unconfinedTestSandbox } from "./testSandbox";

// These tests exercise the gate flow, not the OS boundary (sandbox.test.ts does): gates run unconfined here.
setDefaultGateSandbox(unconfinedTestSandbox());

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
		if (/"role\\":\\"integration\\"/.test(seen))
			return turn === 0 ? call("factory_run_gates", {}) : submit("report", "combined ok");
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
	expect(status.integrate).toBe("completed");
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
	expect(settled.nodes).toHaveLength(7);
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
	await expect(landFactory(run, plan)).rejects.toThrow("nothing was changed");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
	expect(run.readMeta("coder-a")?.committed).toBeTruthy();

	// A correction after the landing commit lands only once it passed fresh gates.
	writeFileSync(join(meta.path, "src", "a", "y.txt"), "correction\n");
	await expect(landFactory(run, plan)).rejects.toThrow("no fresh passing gate record");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);

	// Once the conflict is gone, the retry merges the recorded commit and the gated correction.
	git(repo, "reset", "--hard", "HEAD~1");
	expect(await landFactory(run, plan)).toMatchObject([{ node: "coder-a", status: "landed" }]);
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe("from the coder\n");
	expect(lf(readFileSync(join(repo, "src", "a", "y.txt"), "utf8"))).toBe("correction\n");
	expect(git(repo, "log", "--format=%s")).toContain("factory: land coder-a");
	expect(existsSync(meta.path)).toBe(false);
});

test("landing never touches a merge the person has in progress", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	// A manual merge that stopped on a conflict.
	git(repo, "checkout", "-q", "-b", "side");
	writeFileSync(join(repo, "README.md"), "side\n");
	git(repo, "commit", "-qam", "side");
	git(repo, "checkout", "-q", "main");
	writeFileSync(join(repo, "README.md"), "main\n");
	git(repo, "commit", "-qam", "main");
	expect(Bun.spawnSync(["git", "merge", "side"], { cwd: repo }).exitCode).not.toBe(0);
	await expect(
		landFactory(run, { sources: ["coder-a"], release: "release", target: "main" }),
	).rejects.toThrow("merge in progress");
	const mergeHead = Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], {
		cwd: repo,
	});
	expect(mergeHead.exitCode).toBe(0);
	expect(run.readMeta("coder-a")?.committed).toBeUndefined();
});

/** A commit on its own branch that adds `file`, for landing tests. */
function featureCommit(repo: string, file: string, content: string): string {
	git(repo, "checkout", "-q", "-b", `feature-${serial++}`);
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", file), content);
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", `add ${file}`);
	const sha = git(repo, "rev-parse", "HEAD").trim();
	git(repo, "checkout", "-q", "main");
	return sha;
}

test("landing merges outside the checkout, so a branch switch cannot redirect it", async () => {
	const repo = makeRepo();
	const sha = featureCommit(repo, "f.txt", "feature\n");
	// The person switched to another branch right before the merge.
	git(repo, "checkout", "-q", "-b", "elsewhere");
	const elsewhere = git(repo, "rev-parse", "HEAD").trim();
	const tip = await landOnTarget(repo, join(root, "landing-a"), "main", sha, "factory: land f");
	expect(git(repo, "rev-parse", "main").trim()).toBe(tip);
	expect(git(repo, "rev-parse", "elsewhere").trim()).toBe(elsewhere);
	expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("elsewhere");
	expect(existsSync(join(repo, "src", "f.txt"))).toBe(false);
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
});

test("landing on the checked-out target brings the checkout along and never touches a conflict", async () => {
	const repo = makeRepo();
	const sha = featureCommit(repo, "f.txt", "feature\n");
	const tip = await landOnTarget(repo, join(root, "landing-b"), "main", sha, "factory: land f");
	expect(git(repo, "rev-parse", "HEAD").trim()).toBe(tip);
	expect(lf(readFileSync(join(repo, "src", "f.txt"), "utf8"))).toBe("feature\n");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");

	// A conflicting source: the merge fails in the throwaway checkout, main and the files stay as they were.
	const conflicting = featureCommit(repo, "f.txt", "other\n");
	writeFileSync(join(repo, "src", "f.txt"), "main edit\n");
	git(repo, "commit", "-qam", "main edit");
	const before = git(repo, "rev-parse", "main").trim();
	await expect(
		landOnTarget(repo, join(root, "landing-b"), "main", conflicting, "factory: land g"),
	).rejects.toThrow("nothing was changed");
	expect(git(repo, "rev-parse", "main").trim()).toBe(before);
	expect(git(repo, "status", "--porcelain").trim()).toBe("");

	// Local edits to a file the landing changes are never overwritten: the landing refuses first.
	const next = featureCommit(repo, "h.txt", "h\n");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "h.txt"), "my own draft\n");
	await expect(
		landOnTarget(repo, join(root, "landing-b"), "main", next, "factory: land h"),
	).rejects.toThrow("uncommitted changes touch");
	expect(git(repo, "rev-parse", "main").trim()).toBe(before);
	expect(lf(readFileSync(join(repo, "src", "h.txt"), "utf8"))).toBe("my own draft\n");
});

test("a branch switch cannot slip between the target check and the checkout sync", async () => {
	const repo = makeRepo();
	const sha = featureCommit(repo, "f.txt", "feature\n");
	const switches: number[] = [];
	const tip = await landOnTarget(repo, join(root, "landing-c"), "main", sha, "factory: land f", {
		insideCheckoutLock: async () => {
			// The person switches branches in exactly the interval the review named, quiet or not. Neither
			// form can write HEAD while landing holds its lock, so both fail instead of being synced into.
			for (const args of [
				["checkout", "-b", "elsewhere"],
				["checkout", "-q", "-b", "elsewhere2"],
			])
				switches.push(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode);
		},
	});
	expect(switches.every((code) => code !== 0)).toBe(true);
	expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
	expect(git(repo, "rev-parse", "main").trim()).toBe(tip);
	expect(git(repo, "rev-parse", "HEAD").trim()).toBe(tip);
	expect(lf(readFileSync(join(repo, "src", "f.txt"), "utf8"))).toBe("feature\n");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");

	// While git itself holds the checkout's index lock, landing refuses and changes nothing.
	const next = featureCommit(repo, "g.txt", "g\n");
	const lock = join(repo, ".git", "index.lock");
	writeFileSync(lock, "");
	await expect(
		landOnTarget(repo, join(root, "landing-c"), "main", next, "factory: land g"),
	).rejects.toThrow("Git is busy");
	expect(git(repo, "rev-parse", "main").trim()).toBe(tip);
	rmSync(lock);
});

test("landing carries the validated snapshot to the merge and keeps edits made after the check", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "gated\n");
	const record = await runFactoryGates(run, meta);
	expect(record.ok).toBe(true);
	const landed = await landFactory(
		run,
		{ sources: ["coder-a"], release: "release", target: "main" },
		{
			afterGateCheck: async () => {
				// A concurrent gate run replaces the record, and someone edits the worktree, after the check.
				run.writeGateRecord("coder-a", { ...record, ok: false, reason: "replaced" });
				writeFileSync(join(meta.path, "src", "a", "late.txt"), "late edit\n");
			},
		},
	);
	expect(landed).toMatchObject([{ node: "coder-a", status: "landed", keptWorktree: true }]);
	// What landed is exactly the validated snapshot: the gated file, not the late edit.
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe("gated\n");
	expect(existsSync(join(repo, "src", "a", "late.txt"))).toBe(false);
	// The late edit is preserved in the kept worktree.
	expect(lf(readFileSync(join(meta.path, "src", "a", "late.txt"), "utf8"))).toBe("late edit\n");
});

test("a person's merge of the same factory commit keeps its MERGE_HEAD and staged resolution", async () => {
	const repo = makeRepo();
	const sha = featureCommit(repo, "f.txt", "factory\n");
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "f.txt"), "main\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "main side");
	// The person merges that very commit by hand, hits the conflict and stages a resolution.
	expect(Bun.spawnSync(["git", "merge", sha], { cwd: repo }).exitCode).not.toBe(0);
	writeFileSync(join(repo, "src", "f.txt"), "resolved by hand\n");
	git(repo, "add", "src/f.txt");
	const before = git(repo, "rev-parse", "main").trim();
	await expect(
		landOnTarget(repo, join(root, "landing-d"), "main", sha, "factory: land f"),
	).rejects.toThrow();
	expect(git(repo, "rev-parse", "MERGE_HEAD").trim()).toBe(sha);
	expect(lf(git(repo, "show", ":src/f.txt"))).toBe("resolved by hand\n");
	expect(git(repo, "rev-parse", "main").trim()).toBe(before);
});

test("a HEAD lock that stays busy after the ref moved names both tips for recovery", async () => {
	const repo = makeRepo();
	const sha = featureCommit(repo, "f.txt", "feature\n");
	const before = git(repo, "rev-parse", "main").trim();
	const headLock = join(repo, ".git", "HEAD.lock");
	let message = "";
	try {
		await landOnTarget(repo, join(root, "landing-f"), "main", sha, "factory: land f", {
			// Someone takes HEAD's lock right after the ref moved, and keeps it.
			afterRefUpdate: async () => writeFileSync(headLock, ""),
		});
	} catch (error) {
		message = (error as Error).message;
	} finally {
		rmSync(headLock, { force: true });
	}
	const after = git(repo, "rev-parse", "main").trim();
	expect(after).not.toBe(before);
	expect(message).toContain(`git read-tree -m -u ${before} ${after}`);
	// Following the named recovery brings the checkout to the landed commit.
	git(repo, "read-tree", "-m", "-u", before, after);
	expect(lf(readFileSync(join(repo, "src", "f.txt"), "utf8"))).toBe("feature\n");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
});

test("a staged rename of a landed file blocks the landing before the target moves", async () => {
	const repo = makeRepo();
	mkdirSync(join(repo, "src"), { recursive: true });
	writeFileSync(join(repo, "src", "f.txt"), "base\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "base f");
	const sha = featureCommit(repo, "f.txt", "landed\n");
	const before = git(repo, "rev-parse", "main").trim();
	// The person renames the very file the landing changes; status lists the new path first.
	git(repo, "mv", "src/f.txt", "src/renamed.txt");
	await expect(
		landOnTarget(repo, join(root, "landing-e"), "main", sha, "factory: land f"),
	).rejects.toThrow("src/f.txt");
	expect(git(repo, "rev-parse", "main").trim()).toBe(before);
});

test("a landing that stopped while recording its gated commit resumes it", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	const record = await runFactoryGates(run, meta);
	const sha = record.snapshot ?? "";
	const head = git(meta.path, "rev-parse", "HEAD").trim();
	// The host stopped right after moving the branch onto the gated commit, before recording it.
	run.writeMeta({ ...meta, recording: { from: head, to: sha } });
	git(meta.path, "reset", "-q", sha);
	expect(
		await landFactory(run, { sources: ["coder-a"], release: "release", target: "main" }),
	).toMatchObject([{ node: "coder-a", status: "landed" }]);
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe("x\n");
});

test("an interrupted record write leaves the previous record readable and landing resumes", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	const file = join(run.options.worktreeRoot, ".meta", run.dagId, "coder-a.json");
	// A host stop mid-write leaves only a partial temp file behind; the record itself is untouched.
	writeFileSync(`${file}.${process.pid}.1.tmp`, '{"nodeId": "coder-a", "pa');
	expect(run.readMeta("coder-a")).toMatchObject({ nodeId: "coder-a", path: meta.path });
	// A failing replacement never corrupts the record either.
	expect(() => writeAtomically(join(file, "not-a-dir", "x.json"), "{}")).toThrow();
	expect(run.readMeta("coder-a")).toMatchObject({ nodeId: "coder-a" });
	expect(
		await landFactory(run, { sources: ["coder-a"], release: "release", target: "main" }),
	).toMatchObject([{ node: "coder-a", status: "landed" }]);
});

test("a host stop after the branch moved but before the move was recorded resumes from the saved intent", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	const plan = { sources: ["coder-a"], release: "release", target: "main" };
	// The host stops right after `git reset` moved the branch, before the next metadata write.
	await expect(
		landFactory(run, plan, {
			afterBranchMove: async () => {
				throw new Error("host stopped");
			},
		}),
	).rejects.toThrow("host stopped");
	const saved = run.readMeta("coder-a");
	expect(saved?.recording).toBeTruthy();
	expect(saved?.committed).toBeUndefined();
	expect(git(meta.path, "rev-parse", "HEAD").trim()).toBe(saved?.recording?.to ?? "");
	// The next landing finishes the recorded move and lands.
	expect(await landFactory(run, plan)).toMatchObject([{ node: "coder-a", status: "landed" }]);
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe("x\n");
});

test("a host stop inside the metadata write that records the move resumes from the saved intent", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	expect((await runFactoryGates(run, meta)).ok).toBe(true);
	const plan = { sources: ["coder-a"], release: "release", target: "main" };
	// The write that records the finished move stops after its temp file, before the rename.
	setRecordWriteSeamForTests((file, content) => {
		const record = JSON.parse(content) as { committed?: string; landed?: boolean };
		if (file.endsWith("coder-a.json") && record.committed && !record.landed)
			throw new Error("host stopped mid-write");
	});
	try {
		await expect(landFactory(run, plan)).rejects.toThrow("host stopped mid-write");
	} finally {
		setRecordWriteSeamForTests(undefined);
	}
	const saved = run.readMeta("coder-a");
	expect(saved?.recording).toBeTruthy();
	expect(saved?.committed).toBeUndefined();
	expect(git(meta.path, "rev-parse", "HEAD").trim()).toBe(saved?.recording?.to ?? "");
	expect(await landFactory(run, plan)).toMatchObject([{ node: "coder-a", status: "landed" }]);
	expect(lf(readFileSync(join(repo, "src", "a", "x.txt"), "utf8"))).toBe("x\n");
});

test("a cancelled gate run is never recorded, and drifted gate definitions refuse", async () => {
	const repo = makeRepo();
	const run = unitRun(repo);
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	const cancelled = new AbortController();
	cancelled.abort(new Error("cancelled"));
	await expect(runFactoryGates(run, meta, cancelled.signal)).rejects.toThrow();
	expect(run.readGateRecord("coder-a")).toBeUndefined();
	// The checkout's test script changes after the worktree was made: the snapshot would run the old one.
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ name: "demo", scripts: { test: 'bun -e "process.exit(1)"' } }),
	);
	const record = await runFactoryGates(run, meta);
	expect(record.ok).toBe(false);
	expect(record.reason).toContain("gate definitions changed");
});

test("gates test an immutable snapshot: a gate process cannot change the worktree", async () => {
	const repo = makeRepo();
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({
			name: "demo",
			scripts: {
				test: "bun -e \"require('fs').writeFileSync('src/a/touched.txt', 'by the gate')\"",
			},
		}),
	);
	git(repo, "commit", "-qam", "a gate that writes");
	const run = unitRun(repo);
	const meta = await run.ensureWorktree("coder-a", { owns: ["src/a/**"], avoid: [] });
	mkdirSync(join(meta.path, "src", "a"), { recursive: true });
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	const record = await runFactoryGates(run, meta);
	expect(record.ok).toBe(true);
	expect(record.snapshot).toBeTruthy();
	// The write landed in the throwaway checkout, never in the coder's worktree.
	expect(existsSync(join(meta.path, "src", "a", "touched.txt"))).toBe(false);
	expect((await sourceStatus(run, meta)).gates?.fresh).toBe(true);
	// Any change, even one undone afterwards, is judged by content: X -> Y is stale, back to X is fresh again.
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "y\n");
	expect((await sourceStatus(run, meta)).gates?.fresh).toBe(false);
	writeFileSync(join(meta.path, "src", "a", "x.txt"), "x\n");
	expect((await sourceStatus(run, meta)).gates?.fresh).toBe(true);
});

test("worker paths refuse symlinks and reserved names in any case", async () => {
	const repo = makeRepo();
	const run = unitRun(repo);
	const meta = await run.ensureWorktree("coder-a", { owns: [], avoid: [] });
	for (const path of [".GIT/config", ".git./config", "Node_Modules/x.js", "a:b.txt"])
		expect(() => confinedPath(meta.path, path)).toThrow();
	mkdirSync(join(meta.path, "src"), { recursive: true });
	let linked = true;
	try {
		symlinkSync(join(root, "factory-escape-target.txt"), join(meta.path, "src", "out.txt"));
	} catch {
		linked = false; // Windows without symlink privilege: nothing to exercise here.
	}
	if (linked) {
		expect(() => confinedPath(meta.path, "src/out.txt")).toThrow("Symbolic links");
		expect(existsSync(join(root, "factory-escape-target.txt"))).toBe(false);
	}
	expect(confinedPath(meta.path, "src/ok.txt")).toBe(join(meta.path, "src", "ok.txt"));
});

test("a changed gate definition is never gated, even when the coder owns it", async () => {
	const repo = makeRepo();
	const run = unitRun(repo);
	const meta = await run.ensureWorktree("coder-a", { owns: ["package.json", "src/**"], avoid: [] });
	writeFileSync(
		join(meta.path, "package.json"),
		JSON.stringify({ name: "demo", scripts: { test: 'bun -e "process.exit(0)"' } }, null, 1),
	);
	const record = await runFactoryGates(run, meta);
	expect(record.ok).toBe(false);
	expect(record.results).toHaveLength(0);
	expect(record.reason).toContain("changed build or gate definitions");
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
		"integrate",
		"review",
		"release",
		"land",
	]);
	const release = definition.nodes.find((node) => node.id === "release");
	expect(release?.approval?.authority).toBe("human");
	expect(Object.keys(release?.inputs ?? {})).toEqual(["gate-a", "integrate", "review"]);
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
	return (tool: string, sessionId: string, input: unknown = {}) =>
		(handler as Handler)(
			{ type: "tool_call", toolName: tool, toolCallId: "t", input },
			{ sessionManager: { getSessionId: () => sessionId }, signal: undefined },
		);
}

test("the integration node's submitted output is replaced by the host's own verdict", async () => {
	const repo = makeRepo();
	const untrusted = unitRun(repo, { trusted: false });
	untrusted.bind("integ", {
		nodeId: "integrate",
		node: { role: "integration", sources: ["coder-a"], target: "main" },
	});
	const submitTool = guardHandler(untrusted);
	// The model claims success; the host has no passing record for the combined change.
	const input: { outputs: Record<string, unknown> } = {
		outputs: {
			report: { kind: "text", text: "All green, ship it." },
			extra: { kind: "text", text: "x" },
		},
	};
	expect(await submitTool("dag_submit_result", "integ", input)).toBeUndefined();
	expect(Object.keys(input.outputs)).toEqual(["report"]);
	const text = (input.outputs.report as { text: string }).text;
	expect(text).toContain("Host verdict for the combined change: FAIL");
	expect(text).toContain("not trusted");
	expect(text).not.toContain("All green");
	expect(untrusted.readIntegrationRecord("integrate")?.ok).toBe(false);
});

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

test("the template gates the combined change: an integrate node between the gates and the release", () => {
	expect(() =>
		buildFactoryDefinition({
			title: "t",
			target: "main",
			coders: [{ id: "integrate", task: "x" }],
		}),
	).toThrow("reserved");
	const definition = buildFactoryDefinition({
		title: "t",
		target: "main",
		coders: [
			{ id: "a", task: "x", owns: ["src/a/**"] },
			{ id: "b", task: "y", owns: ["src/b/**"] },
		],
		models: { integration: { model: { provider: "p", id: "scout" } } },
	});
	const byId = (id: string) => definition.nodes.find((node) => node.id === id);
	const integrate = byId("integrate");
	expect(parseFactoryNode(integrate?.session?.systemPrompt)).toEqual({
		role: "integration",
		sources: ["a", "b"],
		target: "main",
	});
	expect(integrate?.session?.tools).toEqual([
		"factory_report",
		"factory_run_gates",
		"factory_diff",
	]);
	expect(integrate?.session?.model).toEqual({ provider: "p", id: "scout" });
	expect(Object.keys(integrate?.inputs ?? {})).toEqual(["gate-a", "gate-b"]);
	expect(integrate?.outputs).toEqual({ report: { kind: "text" } });
	expect(Object.keys(byId("release")?.inputs ?? {})).toEqual(["gate-a", "gate-b", "integrate"]);
	const wired = (id: string) => definition.connections.some((connection) => connection.id === id);
	expect(wired("gate-a-to-integrate") && wired("gate-b-to-integrate")).toBe(true);
	expect(wired("integrate-to-release")).toBe(true);
	expect(parseFactoryNode(byId("release")?.session?.systemPrompt)).toMatchObject({
		role: "release",
		integration: "integrate",
	});
	expect(parseFactoryNode(byId("land")?.session?.systemPrompt)).toMatchObject({
		role: "land",
		integration: "integrate",
	});
	expect(parseFactoryNode(factoryInspector(["a"], "integrate").systemPromptSuffix)).toEqual({
		role: "inspector",
		sources: ["a"],
		integration: "integrate",
	});
	// Definitions written before the integration role keep parsing: the field is only enforced when present.
	expect(
		parseFactoryNode(
			encodeFactoryNode({ role: "land", sources: ["a"], release: "release", target: "main" }),
		),
	).toEqual({ role: "land", sources: ["a"], release: "release", target: "main" });
});

/** a.txt and b.txt are each fine alone; the gate fails only when both exist and disagree. */
const CONSISTENT_GATE =
	"bun -e \"const fs = require('fs'); const read = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; const a = read('a.txt'); const b = read('b.txt'); process.exit(a && b && a !== b ? 1 : 0)\"";

const SOURCES = ["coder-a", "coder-b"];
const INTEGRATE = { sources: SOURCES, target: "main" };
const LAND = { sources: SOURCES, release: "release", target: "main", integration: "integrate" };

/** Two coders in their own worktrees, each with a passing per-coder gate record. */
async function twoGatedCoders(contents: { a: string; b: string }, gate = PASSING_GATE) {
	const repo = makeRepo(gate);
	const run = unitRun(repo, { trusted: true, approved: true });
	const a = await run.ensureWorktree("coder-a", { owns: ["a.txt"], avoid: [] });
	const b = await run.ensureWorktree("coder-b", { owns: ["b.txt"], avoid: [] });
	writeFileSync(join(a.path, "a.txt"), contents.a);
	writeFileSync(join(b.path, "b.txt"), contents.b);
	expect((await runFactoryGates(run, a)).ok).toBe(true);
	expect((await runFactoryGates(run, b)).ok).toBe(true);
	return { repo, run, a, b };
}

test("the combined gate passes on two disjoint coders and records exactly what it merged", async () => {
	const { repo, run, a, b } = await twoGatedCoders({ a: "same\n", b: "same\n" }, CONSISTENT_GATE);
	const record = await runIntegrationGates(run, "integrate", INTEGRATE);
	expect(record.ok).toBe(true);
	expect(record.commands.length).toBeGreaterThan(0);
	expect(record.targetTip).toBe(git(repo, "rev-parse", "main").trim());
	expect(record.sources).toEqual({
		"coder-a": run.readGateRecord("coder-a")?.snapshot ?? "",
		"coder-b": run.readGateRecord("coder-b")?.snapshot ?? "",
	});
	expect(git(repo, "rev-parse", `${record.combined}^{tree}`).trim()).toBe(record.tree);
	expect(run.readIntegrationRecord("integrate")).toEqual(record);
	// Nothing happened to the person's checkout, and no scratch checkout is left registered.
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
	expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(".integration");
	expect(existsSync(a.path) && existsSync(b.path)).toBe(true);
});

test("the combined gate fails when the merged tree breaks a gate that each branch passes", async () => {
	const { repo, run } = await twoGatedCoders({ a: "one\n", b: "two\n" }, CONSISTENT_GATE);
	const record = await runIntegrationGates(run, "integrate", INTEGRATE);
	expect(record.ok).toBe(false);
	expect(record.results.some((result) => !result.ok)).toBe(true);
	expect(record.combined).not.toBe("");
	expect(git(repo, "rev-parse", "main").trim()).toBe(record.targetTip);
	await expect(landFactory(run, LAND)).rejects.toThrow("did not pass its gates");
	expect(existsSync(join(repo, "a.txt"))).toBe(false);
});

test("a merge conflict between sources fails the combined gate with a plain reason", async () => {
	const repo = makeRepo();
	const run = unitRun(repo, { trusted: true, approved: true });
	for (const [id, content] of [
		["coder-a", "from a\n"],
		["coder-b", "from b\n"],
	] as const) {
		const meta = await run.ensureWorktree(id, { owns: ["shared.txt"], avoid: [] });
		writeFileSync(join(meta.path, "shared.txt"), content);
		expect((await runFactoryGates(run, meta)).ok).toBe(true);
	}
	const record = await runIntegrationGates(run, "integrate", INTEGRATE);
	expect(record.ok).toBe(false);
	expect(record.reason).toContain("Merging coder-b into the combined change failed");
	expect(record.results).toEqual([]);
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
});

test("the combined gate fails closed without a fresh gate record, trust or a sandbox", async () => {
	const { repo, run, a } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	writeFileSync(join(a.path, "a.txt"), "edited after its gates\n");
	const stale = await runIntegrationGates(run, "integrate", INTEGRATE);
	expect(stale.ok).toBe(false);
	expect(stale.reason).toContain("coder-a has no fresh passing gate record");
	expect(stale.reason).toContain("retry the integrate node");
	expect((await runFactoryGates(run, a)).ok).toBe(true);
	expect((await runIntegrationGates(run, "integrate", INTEGRATE)).ok).toBe(true);

	const untrusted = unitRun(repo, { trusted: false });
	expect((await runIntegrationGates(untrusted, "integrate", INTEGRATE)).reason).toContain(
		"not trusted",
	);

	const caged = new FactoryRun({
		workspaceId: "unit",
		dagId: run.dagId,
		cwd: repo,
		worktreeRoot: run.options.worktreeRoot,
		isTrusted: () => true,
		releaseApproved: async () => true,
		sandbox: {
			kind: "missing",
			availability: async () => ({ ok: false, reason: "No sandbox on this host." }),
			launch: async () => {
				throw new Error("must not run");
			},
		},
	});
	const refused = await runIntegrationGates(caged, "integrate", INTEGRATE);
	expect(refused.ok).toBe(false);
	expect(refused.reason).toBe("No sandbox on this host.");
	expect(refused.results).toEqual([]);
});

test("landing with an integration node needs a passing record for exactly what it merges", async () => {
	const { repo, run, a } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await expect(landFactory(run, LAND)).rejects.toThrow("no gate record yet");

	await runIntegrationGates(run, "integrate", INTEGRATE);
	// A source gated again after a change is a different commit than the one integrated.
	writeFileSync(join(a.path, "a.txt"), "changed\n");
	expect((await runFactoryGates(run, a)).ok).toBe(true);
	await expect(landFactory(run, LAND)).rejects.toThrow("does not cover what would land now");

	await runIntegrationGates(run, "integrate", INTEGRATE);
	// The target moved after the combined run.
	writeFileSync(join(repo, "other.txt"), "other\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "moved");
	await expect(landFactory(run, LAND)).rejects.toThrow("main moved since the combined gate run");
	expect(existsSync(join(repo, "a.txt"))).toBe(false);

	await runIntegrationGates(run, "integrate", INTEGRATE);
	expect(await landFactory(run, LAND)).toMatchObject([
		{ node: "coder-a", status: "landed" },
		{ node: "coder-b", status: "landed" },
	]);
	expect(lf(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("changed\n");
	expect(lf(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("b\n");
});

test("a source set that differs from the combined run is refused", async () => {
	const { run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await runIntegrationGates(run, "integrate", INTEGRATE);
	const first = run.readIntegrationRecord("integrate");
	run.writeIntegrationRecord("integrate", {
		...(first as NonNullable<typeof first>),
		sources: { "coder-a": first?.sources["coder-a"] ?? "" },
	});
	await expect(landFactory(run, LAND)).rejects.toThrow("does not cover what would land now");
});

test("a landing that resumes after some sources landed accepts a target moved only by them", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await runIntegrationGates(run, "integrate", INTEGRATE);
	// coder-a landed in an earlier attempt of this release.
	await landFactory(run, { sources: ["coder-a"], release: "release", target: "main" });
	expect(run.readMeta("coder-a")?.landed).toBe(true);
	expect(await landFactory(run, LAND)).toMatchObject([
		{ node: "coder-a", status: "already-landed" },
		{ node: "coder-b", status: "landed" },
	]);
	expect(existsSync(join(repo, "b.txt"))).toBe(true);
});

test("a resumed landing is refused when the recorded target tip is not an ancestor of the target", async () => {
	const { run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	const record = await runIntegrationGates(run, "integrate", INTEGRATE);
	await landFactory(run, { sources: ["coder-a"], release: "release", target: "main" });
	run.writeIntegrationRecord("integrate", { ...record, targetTip: record.combined });
	await expect(landFactory(run, LAND)).rejects.toThrow("main moved since the combined gate run");
});

test("a resumed landing refuses a commit that is not one of its own landings", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await runIntegrationGates(run, "integrate", INTEGRATE);
	await landFactory(run, { sources: ["coder-a"], release: "release", target: "main" });
	// Someone else lands on main after coder-a: the remaining source was never tested on top of it.
	writeFileSync(join(repo, "other.txt"), "other\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "someone else");
	await expect(landFactory(run, LAND)).rejects.toThrow(
		"main moved after this release's last landing",
	);
	expect(existsSync(join(repo, "b.txt"))).toBe(false);
});

test("a landing that stopped right after its target update finishes on retry", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await runIntegrationGates(run, "integrate", INTEGRATE);
	await expect(
		landFactory(run, LAND, {
			afterRefUpdate: async () => {
				throw new Error("host stopped");
			},
		}),
	).rejects.toThrow("host stopped");
	// The target moved, but nothing was recorded as landed: only the intent is on disk.
	expect(run.readMeta("coder-a")?.landed).toBeFalsy();
	expect(run.readMeta("coder-a")?.landing).toBeDefined();
	const before = git(repo, "rev-parse", "main").trim();
	expect(run.readMeta("coder-a")?.landing?.to).toBe(before);

	expect(await landFactory(run, LAND)).toMatchObject([
		{ node: "coder-a", status: "landed", commit: before },
		{ node: "coder-b", status: "landed" },
	]);
	expect(run.readMeta("coder-a")?.landed).toBe(true);
	// coder-a was not merged a second time, and the checkout holds both changes.
	expect(git(repo, "rev-list", "--merges", "--count", "main").trim()).toBe("2");
	expect(lf(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("a\n");
	expect(lf(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("b\n");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
});

test("recovering a stopped landing keeps unrelated staged changes and still syncs the landed files", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await runIntegrationGates(run, "integrate", INTEGRATE);
	await expect(
		landFactory(run, LAND, {
			afterRefUpdate: async () => {
				throw new Error("host stopped");
			},
		}),
	).rejects.toThrow("host stopped");
	// The person staged an unrelated file before the retry.
	writeFileSync(join(repo, "mine.txt"), "mine\n");
	git(repo, "add", "mine.txt");

	await landFactory(run, LAND);
	expect(lf(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("a\n");
	expect(lf(readFileSync(join(repo, "b.txt"), "utf8"))).toBe("b\n");
	// Only their own staged file differs from HEAD: the landed files are not shown as reversed.
	expect(git(repo, "diff", "--cached", "--name-status").trim()).toBe("A\tmine.txt");
	expect(readFileSync(join(repo, "mine.txt"), "utf8")).toBe("mine\n");
});

test("a branch switch cannot slip into a recovery's checkout sync either", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	await runIntegrationGates(run, "integrate", INTEGRATE);
	await expect(
		landFactory(run, LAND, {
			afterRefUpdate: async () => {
				throw new Error("host stopped");
			},
		}),
	).rejects.toThrow("host stopped");
	const switches: number[] = [];
	await landFactory(run, LAND, {
		insideCheckoutLock: async () => {
			// The person switches branches inside the recovery's sync interval, quiet or not: neither form can
			// write HEAD while the recovery holds its lock, so both fail instead of being synced into.
			for (const args of [
				["checkout", "-b", `elsewhere-${switches.length}`],
				["checkout", "-q", "-b", `elsewhere-q-${switches.length}`],
			])
				switches.push(Bun.spawnSync(["git", ...args], { cwd: repo }).exitCode);
		},
	});
	expect(switches.length).toBeGreaterThanOrEqual(4);
	expect(switches.every((code) => code !== 0)).toBe(true);
	expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
	expect(lf(readFileSync(join(repo, "a.txt"), "utf8"))).toBe("a\n");
	expect(git(repo, "status", "--porcelain").trim()).toBe("");
});

test("the integration guard reruns the combined gates when the target moved since the record", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	const first = await runIntegrationGates(run, "integrate", INTEGRATE);
	run.bind("integ", { nodeId: "integrate", node: { role: "integration", ...INTEGRATE } });
	const submit = async () => {
		const input = { outputs: { report: { kind: "text", text: "ok" } } };
		await guardHandler(run)("dag_submit_result", "integ", input);
		return input.outputs.report as { text: string };
	};
	// Still fresh: the record is reused as it is.
	await submit();
	expect(run.readIntegrationRecord("integrate")?.ranAt).toBe(first.ranAt);

	writeFileSync(join(repo, "other.txt"), "other\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "moved");
	await submit();
	const rerun = run.readIntegrationRecord("integrate");
	expect(rerun?.targetTip).toBe(git(repo, "rev-parse", "main").trim());
	expect(rerun?.targetTip).not.toBe(first.targetTip);
});

test("a merge is made only on the tip the combined gates tested", async () => {
	const repo = makeRepo();
	const sha = featureCommit(repo, "f.txt", "feature\n");
	const tested = git(repo, "rev-parse", "main").trim();
	writeFileSync(join(repo, "other.txt"), "other\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "moved after the gates");
	const moved = git(repo, "rev-parse", "main").trim();
	await expect(
		landOnTarget(repo, join(root, "landing-expected"), "main", sha, "factory: land f", undefined, {
			expectedTip: tested,
		}),
	).rejects.toThrow("no longer at the commit the combined gates tested");
	expect(git(repo, "rev-parse", "main").trim()).toBe(moved);
	const tip = await landOnTarget(
		repo,
		join(root, "landing-expected"),
		"main",
		sha,
		"factory: land f",
		undefined,
		{ expectedTip: moved },
	);
	expect(git(repo, "rev-parse", "main").trim()).toBe(tip);
});

test("a land node of an older definition, without an integration, lands as before", async () => {
	const { repo, run } = await twoGatedCoders({ a: "a\n", b: "b\n" });
	const old = { sources: SOURCES, release: "release", target: "main" };
	expect(await landFactory(run, old)).toMatchObject([
		{ node: "coder-a", status: "landed" },
		{ node: "coder-b", status: "landed" },
	]);
	expect(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt"))).toBe(true);
});
