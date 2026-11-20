import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DagClient, DagDefinition, DagResult, DagSnapshot } from "pi-dag";
import {
	closeAllDags,
	closeWorkspaceDag,
	dagRootDir,
	dagServiceFor,
	removeWorkspaceDag,
} from "./dag";
import { removeWorkspaceDelegation } from "./delegation";

const model = { provider: "dag-host-faux", id: "worker" };
const faux = createFauxCore({
	provider: model.provider,
	api: "dag-host-faux",
	tokensPerSecond: 100_000,
});
const root = mkdtempSync(join(tmpdir(), "trdag-"));
let runtime: ModelRuntime;
let priorDataDir: string | undefined;
let priorAgentDir: string | undefined;
let priorOffline: string | undefined;
let serial = 0;

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

function workspace(): string {
	return `dagws${serial++}`;
}

function owner(workspaceId: string): DagClient {
	return dagServiceFor(workspaceId).bind({
		caller: { kind: "owner", ownerId: "host" },
		signal: new AbortController().signal,
		execution: { kind: "runtime", modelRuntime: runtime, cwd: root, model },
	});
}

function definition(): DagDefinition {
	return {
		title: "Factory step",
		defaults: { tools: [] },
		maxConcurrent: 1,
		nodes: [{ id: "work", task: "Do the work", outputs: { result: { kind: "text" } } }],
		connections: [],
	};
}

async function until(
	client: DagClient,
	dagId: string,
	predicate: (snapshot: DagSnapshot) => boolean,
): Promise<DagSnapshot> {
	let last: DagSnapshot | undefined;
	for (let n = 0; n < 400; n++) {
		last = value(await client.getDag({ dagId }));
		if (predicate(last)) return last;
		await Bun.sleep(5);
	}
	throw new Error(`DAG did not settle: ${JSON.stringify(last)}`);
}

test("a workspace DAG is stored under the host data dir and survives a service restart paused", async () => {
	const workspaceId = workspace();
	const { dagId } = value(
		await owner(workspaceId).execute({
			commandId: "create",
			command: { kind: "create", definition: definition() },
		}),
	);
	expect(existsSync(dagRootDir(workspaceId))).toBe(true);

	await closeWorkspaceDag(workspaceId);

	const restored = value(await owner(workspaceId).getDag({ dagId }));
	expect(restored.mode).toBe("paused");
	expect(restored.nodes.map((node) => node.status)).toEqual(["pending"]);
	const listed = value(await owner(workspaceId).listDags({}));
	expect(listed.items.map((summary) => summary.dagId)).toContain(dagId);
});

test("a completed node's outcome is restored after restart without another model call", async () => {
	const workspaceId = workspace();
	const client = owner(workspaceId);
	const { dagId } = value(
		await client.execute({
			commandId: "create",
			command: { kind: "create", definition: definition() },
		}),
	);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("dag_submit_result", { outputs: { result: { kind: "text", text: "DONE" } } }),
		),
	]);
	const created = value(await client.getDag({ dagId }));
	value(
		await client.execute({
			commandId: "resume",
			dagId,
			expectedVersion: created.version,
			command: { kind: "resume" },
		}),
	);
	const settled = await until(client, dagId, (state) =>
		state.nodes.every((node) => node.status === "completed"),
	);

	await closeWorkspaceDag(workspaceId);
	const calls = faux.state.callCount;

	const restored = value(await owner(workspaceId).getDag({ dagId }));
	expect(restored.nodes.map((node) => node.outcome)).toEqual(
		settled.nodes.map((node) => node.outcome),
	);
	expect(faux.state.callCount).toBe(calls);
});

test("removing a workspace deletes its DAG store", async () => {
	const workspaceId = workspace();
	value(
		await owner(workspaceId).execute({
			commandId: "create",
			command: { kind: "create", definition: definition() },
		}),
	);
	await removeWorkspaceDag(workspaceId);
	removeWorkspaceDelegation(workspaceId);
	expect(existsSync(dagRootDir(workspaceId))).toBe(false);
});
