import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { DagChanged } from "@thinkrail/contracts";
import type { DagClient, DagDefinition, DagResult, DagSnapshot } from "pi-dag";
import { closeAllDags, dagServiceFor } from "./dag";
import { setDagChangeDebounce, setDagPublisher } from "./dagChanges";
import {
	DAG_OPERATOR_ID,
	executeWorkspaceDag,
	listWorkspaceDags,
	readWorkspaceDag,
	readWorkspaceHistory,
	readWorkspaceOutput,
	readWorkspaceQueue,
	toDagCommand,
} from "./dagWire";
import { configurePiRuntime } from "./piRuntime";

const model = { provider: "dag-wire-faux", id: "worker" };
const faux = createFauxCore({
	provider: model.provider,
	api: "dag-wire-faux",
	tokensPerSecond: 100_000,
});
const root = mkdtempSync(join(tmpdir(), "trdagwire-"));
const workspaceId = "dagwirews";
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
	mkdirSync(join(root, "data"), { recursive: true });
	mkdirSync(join(root, "checkout"), { recursive: true });
	writeFileSync(
		join(root, "data", "workspaces.json"),
		JSON.stringify([
			{
				id: workspaceId,
				projectId: "p1",
				name: "wire",
				branch: "main",
				baseBranch: "main",
				worktreePath: join(root, "checkout"),
			},
		]),
	);
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
	configurePiRuntime(runtime);
});

afterEach(async () => {
	setDagPublisher(null);
	setDagChangeDebounce(undefined);
	await closeAllDags();
});

afterAll(() => {
	configurePiRuntime(null);
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

function owner(): DagClient {
	return dagServiceFor(workspaceId).bind({
		caller: { kind: "owner", ownerId: "host" },
		signal: new AbortController().signal,
		execution: { kind: "runtime", modelRuntime: runtime, cwd: join(root, "checkout"), model },
	});
}

function controller(): DagClient {
	return dagServiceFor(workspaceId).bind({
		caller: { kind: "controller", sessionId: "chat-1" },
		signal: new AbortController().signal,
	});
}

const approvalDefinition = (): DagDefinition => ({
	title: `Release ${serial++}`,
	defaults: { tools: [] },
	maxConcurrent: 1,
	nodes: [
		{
			id: "work",
			task: "Do the work",
			outputs: { result: { kind: "text" } },
			approval: { authority: "human", question: "Ship it?" },
		},
	],
	connections: [],
});

async function createDag(): Promise<string> {
	const created = value(
		await owner().execute({
			commandId: `create-${serial++}`,
			command: { kind: "create", definition: approvalDefinition() },
		}),
	);
	return created.dagId;
}

async function until(
	dagId: string,
	predicate: (snapshot: DagSnapshot) => boolean,
): Promise<DagSnapshot> {
	let last: DagSnapshot | undefined;
	for (let n = 0; n < 400; n++) {
		last = value(await owner().getDag({ dagId }));
		if (predicate(last)) return last;
		await Bun.sleep(5);
	}
	throw new Error(`DAG did not settle: ${JSON.stringify(last)}`);
}

test("the UI lists a DAG and approves its human gate without a chat", async () => {
	const dagId = await createDag();
	const changes: DagChanged[] = [];
	setDagPublisher((payload) => changes.push(payload));

	const listed = await listWorkspaceDags(workspaceId);
	expect(listed.find((item) => item.dagId === dagId)).toMatchObject({
		mode: "paused",
		pendingGates: 0,
	});

	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("dag_submit_result", { outputs: { result: { kind: "text", text: "DONE" } } }),
		),
	]);
	const paused = await readWorkspaceDag(workspaceId, dagId);
	const resumed = await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: "ui-resume",
		expectedVersion: paused.version,
		command: { kind: "resume" },
	});
	expect(resumed.dag.mode).toBe("running");
	expect(changes[0]).toEqual({ workspaceId, dagId });

	const waiting = await until(dagId, (snapshot) =>
		snapshot.gates.some((g) => g.disposition === "pending"),
	);
	const view = await readWorkspaceDag(workspaceId, dagId);
	expect(view.nodes.map((node) => node.status)).toEqual(["waiting-approval"]);
	expect(view.gates).toHaveLength(1);
	expect(view.gates[0]).toMatchObject({
		kind: "approval",
		authority: "human",
		question: "Ship it?",
	});
	expect(JSON.stringify(view)).not.toContain("localPath");
	expect((await listWorkspaceDags(workspaceId)).find((i) => i.dagId === dagId)?.pendingGates).toBe(
		1,
	);

	// A chat controller can never release a human-only gate.
	const refused = await controller().execute({
		commandId: "chat-approve",
		dagId,
		expectedVersion: waiting.version,
		command: { kind: "approve", gateId: view.gates[0]?.id ?? "", reason: "chat says yes" },
	});
	expect(refused.ok).toBe(false);

	const approved = await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: "ui-approve",
		expectedVersion: view.version,
		command: { kind: "approve", gateId: view.gates[0]?.id ?? "", reason: "Looks good" },
	});
	expect(approved.dag.gates).toEqual([]);
	const settled = await until(dagId, (snapshot) =>
		snapshot.nodes.every((n) => n.status === "completed"),
	);
	const gate = settled.gates[0];
	expect(gate?.disposition).toBe("approved");
	expect(gate?.decision?.actor).toEqual({ kind: "human", operatorId: DAG_OPERATOR_ID });
});

test("worker progress and settlement are pushed as dag.changed without any wire command", async () => {
	setDagChangeDebounce(10);
	const dagId = await createDag();
	const changes: DagChanged[] = [];
	setDagPublisher((payload) => changes.push(payload));
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("dag_submit_result", { outputs: { result: { kind: "text", text: "DONE" } } }),
		),
	]);
	// The owner binding is not the wire: nothing here goes through executeWorkspaceDag.
	const paused = value(await owner().getDag({ dagId }));
	value(
		await owner().execute({
			commandId: `push-resume-${serial++}`,
			dagId,
			expectedVersion: paused.version,
			command: { kind: "resume" },
		}),
	);
	await until(dagId, (snapshot) => snapshot.gates.some((g) => g.disposition === "pending"));
	await Bun.sleep(100);
	const own = changes.filter((c) => c.dagId === dagId);
	expect(own.length).toBeGreaterThanOrEqual(1);
	expect(own.every((c) => c.workspaceId === workspaceId)).toBe(true);
	// The last push is after the last commit: re-reading it shows the settled node.
	const view = await readWorkspaceDag(workspaceId, dagId);
	expect(view.nodes.map((node) => node.status)).toEqual(["waiting-approval"]);
	// Debounced: a burst of commits (admission, run, proposal, gate) publishes far fewer pushes.
	expect(own.length).toBeLessThanOrEqual(view.version);
});

test("history pages and a node's named output are bounded human reads without storage paths", async () => {
	const dagId = await createDag();
	const big = "x".repeat(2000);
	faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall("dag_submit_result", { outputs: { result: { kind: "text", text: big } } }),
		),
	]);
	expect(await readWorkspaceOutput(workspaceId, dagId, "work", "result")).toBeNull();
	const paused = await readWorkspaceDag(workspaceId, dagId);
	expect(paused.nodes[0]?.outputs).toBeUndefined();
	await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: `hist-resume-${serial++}`,
		expectedVersion: paused.version,
		command: { kind: "resume" },
	});
	await until(dagId, (snapshot) => snapshot.gates.some((g) => g.disposition === "pending"));

	const view = await readWorkspaceDag(workspaceId, dagId);
	expect(view.nodes[0]?.outputs).toEqual(["result"]);
	const whole = await readWorkspaceOutput(workspaceId, dagId, "work", "result");
	expect(whole).toMatchObject({ truncated: false, sizeBytes: big.length });
	expect(whole?.text).toBe(big);
	const output = await readWorkspaceOutput(workspaceId, dagId, "work", "result", 1000);
	expect(output).toMatchObject({
		nodeId: "work",
		name: "result",
		kind: "text",
		truncated: true,
		sizeBytes: big.length,
	});
	expect(output?.text?.length).toBe(1000);
	expect(JSON.stringify(output)).not.toContain("localPath");
	await expect(readWorkspaceOutput(workspaceId, dagId, "work", "missing")).rejects.toMatchObject({
		code: "RESOURCE_UNAVAILABLE",
	});
	await expect(readWorkspaceOutput(workspaceId, dagId, "nope", "result")).rejects.toMatchObject({
		code: "RESOURCE_UNAVAILABLE",
	});
	await expect(readWorkspaceOutput(workspaceId, dagId, "work", "")).rejects.toThrow("Invalid name");

	const first = await readWorkspaceHistory(workspaceId, dagId, undefined, 2);
	expect(first.items).toHaveLength(2);
	expect(first.items[0]).toMatchObject({ kind: "created" });
	expect(first.nextCursor).toBeTruthy();
	const second = await readWorkspaceHistory(workspaceId, dagId, first.nextCursor, 2);
	expect(second.items.length).toBeGreaterThan(0);
	expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
	expect(first.items.some((item) => item.actor === "owner")).toBe(true);
	const everything = JSON.stringify([first, second]);
	for (const forbidden of ["localPath", "artifactId", "sha256", "operatorId", "ownerId"])
		expect(everything).not.toContain(forbidden);
	await expect(readWorkspaceHistory(workspaceId, dagId, undefined, 0)).rejects.toThrow(
		"Invalid limit",
	);
	await expect(readWorkspaceHistory(workspaceId, dagId, "", undefined)).rejects.toThrow(
		"Invalid cursor",
	);
	await expect(readWorkspaceHistory(workspaceId, "../x")).rejects.toThrow("Invalid dagId");
});

test("a stale version is reported as DAG_STALE, not applied", async () => {
	const dagId = await createDag();
	const current = await readWorkspaceDag(workspaceId, dagId);
	await expect(
		executeWorkspaceDag({
			workspaceId,
			dagId,
			commandId: "stale-resume",
			expectedVersion: current.version + 5,
			command: { kind: "resume" },
		}),
	).rejects.toMatchObject({ code: "DAG_STALE" });
	expect((await readWorkspaceDag(workspaceId, dagId)).mode).toBe("paused");
});

test("the wire accepts only whitelisted commands and never a caller", () => {
	expect(toDagCommand({ kind: "pause" })).toEqual({ kind: "pause" });
	expect(toDagCommand({ kind: "interrupt" })).toEqual({
		kind: "interrupt",
		target: { kind: "dag" },
	});
	expect(toDagCommand({ kind: "cancel", nodeId: "a" })).toEqual({
		kind: "cancel",
		target: { kind: "node", nodeId: "a" },
	});
	expect(toDagCommand({ kind: "reject", gateId: "g1", reason: "no" })).toEqual({
		kind: "reject",
		gateId: "g1",
		reason: "no",
	});
	for (const kind of ["dispose", "skip", "edit", "create", "attach-notices", "steer", "reconcile"])
		expect(() => toDagCommand({ kind })).toThrow();
	expect(() => toDagCommand({ kind: "approve", gateId: "g1" })).toThrow();
	expect(() =>
		toDagCommand({ kind: "approve", gateId: "g1", reason: "ok", caller: { kind: "owner" } }),
	).toThrow();
	expect(() => toDagCommand(null)).toThrow();
});

test("ids are validated and unknown workspaces are unavailable", async () => {
	await expect(listWorkspaceDags("../escape")).rejects.toThrow("Invalid workspaceId");
	await expect(readWorkspaceDag(workspaceId, "../x")).rejects.toThrow("Invalid dagId");
	await expect(listWorkspaceDags("nosuchworkspace")).rejects.toMatchObject({
		code: "RESOURCE_UNAVAILABLE",
	});
	await expect(
		executeWorkspaceDag({
			workspaceId,
			dagId: "a",
			commandId: "c",
			expectedVersion: 1,
			command: { kind: "resume" },
			extra: 1,
		}),
	).rejects.toThrow("Invalid DAG request");
});

test("the queue read reports the workspace cap and is validated like the other reads", async () => {
	expect(readWorkspaceQueue(workspaceId)).toEqual({ limit: 4, running: 0, queued: 0 });
	expect(() => readWorkspaceQueue("../escape")).toThrow("Invalid workspaceId");
	expect(() => readWorkspaceQueue("nosuchworkspace")).toThrow("Workspace unavailable");
});
