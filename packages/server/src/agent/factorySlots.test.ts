import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import type { DagClient, DagDefinition, DagResult } from "pi-dag";
import { closeAllDags, dagServiceFor } from "./dag";
import { refreshSubagentConcurrency, setSubagentConcurrencyResolver } from "./delegation";
import {
	DEFAULT_GLOBAL_FACTORY_SLOTS,
	factoryQueueOf,
	globalFactoryQueue,
	setGlobalFactorySlotLimit,
} from "./factory";

const model = { provider: "dag-slots-faux", id: "worker" };
const faux = createFauxCore({
	provider: model.provider,
	api: "dag-slots-faux",
	tokensPerSecond: 100_000,
});
const root = mkdtempSync(join(tmpdir(), "trdagslots-"));
let runtime: ModelRuntime;
let priorDataDir: string | undefined;
let priorAgentDir: string | undefined;
let priorOffline: string | undefined;

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
	release.all();
	await closeAllDags();
	setSubagentConcurrencyResolver(null);
	setGlobalFactorySlotLimit(DEFAULT_GLOBAL_FACTORY_SLOTS);
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

/** The worker turns that are inside the model call right now, and which task each one is. */
let active = 0;
let peak = 0;
let started: string[] = [];
const holding: Array<{ task: string; free: () => void }> = [];
const release = {
	/** Lets every turn currently in the model call finish. */
	all(): void {
		for (const item of holding.splice(0)) item.free();
	},
	task(task: string): void {
		const index = holding.findIndex((item) => item.task === task);
		if (index >= 0) holding.splice(index, 1)[0]?.free();
	},
};

const respond: FauxResponseFactory = async (context, options) => {
	const user = JSON.stringify(context.messages.at(-1) ?? "");
	const task = /task-[A-Z]-\d/.exec(user)?.[0] ?? "unknown";
	started.push(task);
	active++;
	peak = Math.max(peak, active);
	try {
		await new Promise<void>((resolve) => {
			holding.push({ task, free: resolve });
			options?.signal?.addEventListener("abort", () => resolve(), { once: true });
		});
	} finally {
		active--;
	}
	return fauxAssistantMessage(
		fauxToolCall("dag_submit_result", { outputs: { result: { kind: "text", text: task } } }),
	);
};

function reset(cap: number): { cap: (n: number) => void } {
	active = 0;
	peak = 0;
	started = [];
	holding.length = 0;
	faux.setResponses(Array.from({ length: 40 }, () => respond));
	let limit = cap;
	setSubagentConcurrencyResolver(() => limit);
	return {
		cap: (n) => {
			limit = n;
			refreshSubagentConcurrency();
		},
	};
}

function value<T>(result: DagResult<T>): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

function owner(workspaceId: string): DagClient {
	return dagServiceFor(workspaceId).bind({
		caller: { kind: "owner", ownerId: "host" },
		signal: new AbortController().signal,
		execution: { kind: "runtime", modelRuntime: runtime, cwd: root, model },
	});
}

function definition(label: string, nodes: number): DagDefinition {
	return {
		title: `DAG ${label}`,
		defaults: { tools: [] },
		maxConcurrent: 8,
		nodes: Array.from({ length: nodes }, (_, index) => ({
			id: `n${index}`,
			task: `task-${label}-${index}`,
			outputs: { result: { kind: "text" as const } },
		})),
		connections: [],
	};
}

async function create(client: DagClient, label: string, nodes: number): Promise<string> {
	return value(
		await client.execute({
			commandId: `create-${label}`,
			command: { kind: "create", definition: definition(label, nodes) },
		}),
	).dagId;
}

async function command(
	client: DagClient,
	dagId: string,
	kind: "resume" | "pause" | "interrupt",
): Promise<void> {
	const snapshot = value(await client.getDag({ dagId }));
	value(
		await client.execute({
			commandId: `${kind}-${dagId}-${snapshot.version}`,
			dagId,
			expectedVersion: snapshot.version,
			command: kind === "interrupt" ? { kind, target: { kind: "dag" } } : { kind },
		}),
	);
}

async function waitFor(what: string, predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let n = 0; n < 3000; n++) {
		if (await predicate()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${what} (active ${active}, started ${started.join(",")})`);
}

async function statuses(client: DagClient, dagIds: string[]): Promise<string[]> {
	const all: string[] = [];
	for (const dagId of dagIds)
		all.push(...value(await client.getDag({ dagId })).nodes.map((node) => node.status));
	return all;
}

async function finish(client: DagClient, dagIds: string[], total: number): Promise<void> {
	await waitFor("every node to complete", async () => {
		release.all();
		return (await statuses(client, dagIds)).filter((s) => s === "completed").length === total;
	});
}

let serial = 0;
const workspace = () => `slotsws${serial++}`;

test("two DAGs of one workspace never run more worker turns than the cap, queue the rest and finish all", async () => {
	reset(2);
	const workspaceId = workspace();
	const client = owner(workspaceId);
	const a = await create(client, "A", 3);
	const b = await create(client, "B", 3);
	await command(client, a, "resume");
	await command(client, b, "resume");

	await waitFor("the cap to be saturated", () => active === 2);
	await waitFor("the rest to queue", () => factoryQueueOf(workspaceId)?.queued === 4);
	expect(factoryQueueOf(workspaceId)).toEqual({ limit: 2, running: 2, queued: 4 });
	await waitFor("two nodes reading running", async () => {
		const now = await statuses(client, [a, b]);
		return (
			now.filter((s) => s === "running").length === 2 &&
			now.filter((s) => s === "queued").length === 4
		);
	});
	expect(active).toBe(2);

	await finish(client, [a, b], 6);
	expect(peak).toBe(2);
	expect(started.length).toBe(6);
	expect(factoryQueueOf(workspaceId)).toEqual({ limit: 2, running: 0, queued: 0 });
}, 60_000);

test("lowering the cap never aborts running work; raising it admits queued work at once", async () => {
	const limits = reset(3);
	const workspaceId = workspace();
	const client = owner(workspaceId);
	const a = await create(client, "A", 3);
	const b = await create(client, "B", 3);
	await command(client, a, "resume");
	await command(client, b, "resume");
	await waitFor(
		"three running and three queued",
		() => active === 3 && factoryQueueOf(workspaceId)?.queued === 3,
	);

	limits.cap(1);
	expect(factoryQueueOf(workspaceId)?.limit).toBe(1);
	await Bun.sleep(30);
	expect(active).toBe(3);
	release.task(started[0] as string);
	await waitFor("one turn to finish", () => active === 2);
	await Bun.sleep(30);
	expect(active).toBe(2);
	release.all();
	await waitFor(
		"one queued turn to start under the lower cap",
		() => active === 1 && started.length === 4,
	);
	expect(factoryQueueOf(workspaceId)).toEqual({ limit: 1, running: 1, queued: 2 });

	limits.cap(3);
	await waitFor("raising to start both queued turns", () => active === 3);
	await finish(client, [a, b], 6);
	expect(peak).toBe(3);
}, 60_000);

test("a paused DAG's queued turns give way to the other DAG and continue once it resumes", async () => {
	reset(1);
	const workspaceId = workspace();
	const client = owner(workspaceId);
	const a = await create(client, "A", 2);
	const b = await create(client, "B", 2);
	await command(client, a, "resume");
	await waitFor("A's first turn", () => started.length === 1);
	await command(client, b, "resume");
	await waitFor("everything admitted", () => factoryQueueOf(workspaceId)?.queued === 3);
	await command(client, a, "pause");

	release.all();
	await waitFor("B to take the slot", () => started.length === 2 && active === 1);
	expect(started[1]).toMatch(/^task-B-/);
	release.all();
	await waitFor("B's second turn", () => started.length === 3 && active === 1);
	expect(new Set(started.slice(1, 3))).toEqual(new Set(["task-B-0", "task-B-1"]));
	release.all();
	await waitFor("B to complete", async () =>
		(await statuses(client, [b])).every((s) => s === "completed"),
	);
	await Bun.sleep(150);
	expect(started).toHaveLength(3);
	const firstA = started[0] as string;
	expect(firstA).toMatch(/^task-A-/);
	expect(factoryQueueOf(workspaceId)).toEqual({ limit: 1, running: 0, queued: 1 });
	expect((await statuses(client, [a])).sort()).toEqual(["completed", "queued"]);

	await command(client, a, "resume");
	await finish(client, [a, b], 4);
	expect(started.at(-1)).toBe(firstA === "task-A-0" ? "task-A-1" : "task-A-0");
	expect(peak).toBe(1);
}, 60_000);

test("interrupting a DAG frees its running slot for the other DAG", async () => {
	reset(1);
	const workspaceId = workspace();
	const client = owner(workspaceId);
	const a = await create(client, "A", 1);
	const b = await create(client, "B", 1);
	await command(client, a, "resume");
	await waitFor("A to run", () => active === 1);
	await command(client, b, "resume");
	await waitFor("B to queue", () => factoryQueueOf(workspaceId)?.queued === 1);

	await command(client, a, "interrupt");
	await waitFor("B to take the slot", () => started.includes("task-B-0") && active === 1);
	await finish(client, [b], 1);
	expect(peak).toBe(1);
}, 60_000);

test("a machine-wide cap holds across workspaces on top of each workspace's own cap, and moves live", async () => {
	reset(4);
	setGlobalFactorySlotLimit(3);
	const one = workspace();
	const two = workspace();
	const clientOne = owner(one);
	const clientTwo = owner(two);
	const a = await create(clientOne, "A", 3);
	const b = await create(clientTwo, "B", 3);
	await command(clientOne, a, "resume");
	await command(clientTwo, b, "resume");

	await waitFor("the machine-wide cap to be saturated", () => active === 3);
	await waitFor(
		"the rest to queue",
		() => (factoryQueueOf(one)?.queued ?? 0) + (factoryQueueOf(two)?.queued ?? 0) === 3,
	);
	await Bun.sleep(40);
	expect(active).toBe(3);
	expect(globalFactoryQueue().limit).toBe(3);
	expect(globalFactoryQueue().running).toBe(3);
	// Each workspace is within its own cap of 4, so it is the global cap that holds the other three back.
	expect(factoryQueueOf(one)?.running).toBeLessThanOrEqual(3);
	expect((factoryQueueOf(one)?.running ?? 0) + (factoryQueueOf(two)?.running ?? 0)).toBe(3);

	// Raising it admits waiting turns at once; lowering never aborts a running turn.
	setGlobalFactorySlotLimit(5);
	await waitFor("two more turns to start", () => active === 5);
	setGlobalFactorySlotLimit(1);
	await Bun.sleep(40);
	expect(active).toBe(5);
	release.all();
	await waitFor("the last turn to start under the lower cap", () => started.length === 6);
	await Bun.sleep(40);
	expect(active).toBeLessThanOrEqual(1);

	await finish(clientOne, [a], 3);
	await finish(clientTwo, [b], 3);
	expect(peak).toBe(5);
	expect(globalFactoryQueue()).toEqual({ limit: 1, running: 0, queued: 0 });
	expect(factoryQueueOf(one)).toEqual({ limit: 4, running: 0, queued: 0 });
}, 60_000);

test("a workspace's own cap still binds when the machine-wide cap is generous", async () => {
	reset(1);
	setGlobalFactorySlotLimit(16);
	const one = workspace();
	const two = workspace();
	const clientOne = owner(one);
	const clientTwo = owner(two);
	const a = await create(clientOne, "A", 3);
	const b = await create(clientTwo, "B", 3);
	await command(clientOne, a, "resume");
	await command(clientTwo, b, "resume");
	await waitFor("one turn per workspace", () => active === 2);
	await Bun.sleep(40);
	expect(active).toBe(2);
	expect(globalFactoryQueue()).toMatchObject({ limit: 16, running: 2 });
	await finish(clientOne, [a], 3);
	await finish(clientTwo, [b], 3);
	expect(peak).toBe(2);
}, 60_000);
