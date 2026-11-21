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
import { readFactoryRoles } from "./dagStart";
import {
	DAG_OPERATOR_ID,
	executeWorkspaceDag,
	listWorkspaceDags,
	readWorkspaceDag,
	readWorkspaceHistory,
	readWorkspaceOutput,
	readWorkspaceQueue,
	replanWorkspaceFactory,
	startWorkspaceFactory,
	startWorkspaceFactoryFromPlan,
	toDagCommand,
} from "./dagWire";
import { encodeFactoryNode, encodePlanRun, type PlanRun, parsePlanRun } from "./factory";
import { configurePiRuntime } from "./piRuntime";

const model = { provider: "dag-wire-faux", id: "worker" };
const faux = createFauxCore({
	provider: model.provider,
	api: "dag-wire-faux",
	tokensPerSecond: 100_000,
});
const otherModel = { provider: "dag-wire-other", id: "reviewer" };
const otherFaux = createFauxCore({
	provider: otherModel.provider,
	api: "dag-wire-other",
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
	runtime.registerProvider(otherModel.provider, {
		api: otherFaux.api,
		baseUrl: "http://faux.local",
		apiKey: "synthetic",
		streamSimple: otherFaux.streamSimple,
		models: [
			{
				id: otherModel.id,
				name: "Reviewer",
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
	// Time-bound rather than count-bound: a loaded machine reads a DAG slowly.
	const deadline = Date.now() + 25_000;
	while (Date.now() < deadline) {
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
	expect(readWorkspaceQueue(workspaceId)).toEqual({
		limit: 4,
		running: 0,
		queued: 0,
		global: { limit: 8, running: 0, queued: 0 },
	});
	expect(() => readWorkspaceQueue("../escape")).toThrow("Invalid workspaceId");
	expect(() => readWorkspaceQueue("nosuchworkspace")).toThrow("Workspace unavailable");
});

async function definitionOf(dagId: string) {
	const snapshot = value(await owner().getDag({ dagId }));
	return JSON.parse(await Bun.file(snapshot.definition.localPath).text()) as DagDefinition;
}

// The runtime also offers built-in models, so every start names its coder and reviewer explicitly.
const fauxRef = { provider: model.provider, id: model.id };
const otherRef = { provider: otherModel.provider, id: otherModel.id };
const startBase = () => ({
	workspaceId,
	commandId: `start-${serial++}`,
	task: "Add the thing",
	roles: { coder: fauxRef, reviewer: otherRef },
});
const twoCoders = [
	{ id: "api", task: "Build the api", owns: ["src/api/**"] },
	{ id: "web", task: "Build the web", owns: ["src/web/**"] },
];

test("the roles read offers the available models and the host's defaults", async () => {
	const roles = await readFactoryRoles(workspaceId);
	const families = new Map(roles.models.map((m) => [`${m.provider}/${m.id}`, m.family]));
	expect(families.get("dag-wire-faux/worker")).toBe("provider:dag-wire-faux");
	expect(families.get("dag-wire-other/reviewer")).toBe("provider:dag-wire-other");
	expect(Object.keys(roles.defaults).sort()).toEqual(["coder", "planner", "reviewer", "scout"]);
	expect(roles.defaults.planner).toEqual(roles.defaults.coder);
	expect(families.has(`${roles.defaults.reviewer.provider}/${roles.defaults.reviewer.id}`)).toBe(
		true,
	);
	expect(roles.sameFamilyOnly).toBe(false);
	await expect(readFactoryRoles("nosuchworkspace")).rejects.toMatchObject({
		code: "RESOURCE_UNAVAILABLE",
	});
});

test("a person starts a factory with chosen coders and role models; it is created paused", async () => {
	const result = await startWorkspaceFactory({
		...startBase(),
		coders: twoCoders,
	});
	expect(result).toMatchObject({ kind: "factory", notes: [] });
	const view = await readWorkspaceDag(workspaceId, result.dagId);
	expect(view.mode).toBe("paused");
	expect(view.nodes.map((n) => n.id)).toEqual([
		"api",
		"gate-api",
		"web",
		"gate-web",
		"review",
		"release",
		"land",
	]);
	const definition = await definitionOf(result.dagId);
	const model = (id: string) => definition.nodes.find((n) => n.id === id)?.session?.model;
	expect(model("api")).toEqual({ provider: "dag-wire-faux", id: "worker" });
	// The reviewer is another family than the coder, by default and by rule.
	expect(model("review")).toEqual({ provider: "dag-wire-other", id: "reviewer" });
	expect(definition.nodes.find((n) => n.id === "release")?.approval?.authority).toBe("human");
});

test("the reviewer must be another family unless the person explicitly allows it, and that is recorded", async () => {
	const sameFamily = {
		...startBase(),
		coders: twoCoders,
		roles: { coder: fauxRef, reviewer: fauxRef },
	};
	await expect(startWorkspaceFactory(sameFamily)).rejects.toMatchObject({
		code: "DAG_REJECTED",
		message: expect.stringContaining("different model family"),
	});
	const allowed = await startWorkspaceFactory({
		...sameFamily,
		commandId: `start-${serial++}`,
		allowSameFamilyReviewer: true,
	});
	expect(allowed.notes).toHaveLength(1);
	expect(allowed.notes[0]).toContain("same family");
	const definition = await definitionOf(allowed.dagId);
	expect(definition.nodes.find((n) => n.id === "release")?.approval?.question).toContain(
		"same family",
	);
	await expect(
		startWorkspaceFactory({
			...startBase(),
			coders: twoCoders,
			roles: { coder: { provider: "x", id: "y" } },
		}),
	).rejects.toMatchObject({ code: "DAG_REJECTED" });
});

test("a start request is validated and replays by command id", async () => {
	const base = startBase();
	const first = await startWorkspaceFactory({ ...base, coders: twoCoders });
	expect((await startWorkspaceFactory({ ...base, coders: twoCoders })).dagId).toBe(first.dagId);
	for (const bad of [
		{ task: "" },
		{ task: "x".repeat(8001) },
		{ commandId: "" },
		{ gateRetries: 6 },
		{ gateRetries: 1.5 },
		{ roles: { cook: { provider: "a", id: "b" } } },
		{ roles: { coder: { provider: "a", id: "b", extra: 1 } } },
		{ allowSameFamilyReviewer: "yes" },
		{ extra: 1 },
		{ coders: [] },
		{ coders: [{ id: "Bad Id", task: "x" }] },
		{ coders: [{ id: "release", task: "x" }] },
		{ coders: [{ id: "gate-x", task: "x" }] },
		{ coders: [{ id: "a", task: "x", owns: ["../outside/**"] }] },
		{ coders: [{ id: "a", task: "x", owns: ["/abs/**"] }] },
		{ coders: [{ id: "a", task: "x", extra: true }] },
		{
			coders: [
				{ id: "a", task: "x" },
				{ id: "b", task: "y" },
			],
		},
		{
			coders: [
				{ id: "a", task: "x", owns: ["src/**"] },
				{ id: "b", task: "y", owns: ["src/b/**"] },
			],
		},
	])
		await expect(startWorkspaceFactory({ ...startBase(), ...bad })).rejects.toThrow();
	await expect(startWorkspaceFactory({ ...startBase(), workspaceId: "../x" })).rejects.toThrow(
		"Invalid workspaceId",
	);
});

function submitPlan(plan: Record<string, unknown>) {
	return fauxAssistantMessage(
		fauxToolCall("dag_submit_result", {
			outputs: { plan: { kind: "json", value: plan as never } },
		}),
	);
}

async function plannedAndApproved(plan: Record<string, unknown>) {
	faux.setResponses([submitPlan(plan)]);
	const started = await startWorkspaceFactory(startBase());
	expect(started.kind).toBe("plan");
	const paused = await readWorkspaceDag(workspaceId, started.dagId);
	expect(paused.nodes).toHaveLength(1);
	expect(paused.nodes[0]).toMatchObject({ id: "planner", planner: true });
	await executeWorkspaceDag({
		workspaceId,
		dagId: started.dagId,
		commandId: `plan-resume-${serial++}`,
		expectedVersion: paused.version,
		command: { kind: "resume" },
	});
	const waiting = await until(started.dagId, (s) =>
		s.gates.some((g) => g.disposition === "pending"),
	);
	return { dagId: started.dagId, waiting };
}

test("a planner proposes coders; nothing is built until a person approves, then the host validates and builds", async () => {
	const plan = { coders: twoCoders };
	const { dagId, waiting } = await plannedAndApproved(plan);

	// The plan is readable like any output, and the planner is read-only on a model of its role.
	const output = await readWorkspaceOutput(workspaceId, dagId, "planner", "plan");
	expect(JSON.parse(output?.text ?? "null")).toEqual(plan);
	const planning = await definitionOf(dagId);
	expect(planning.nodes[0]?.session?.tools).toEqual(["read", "grep", "find", "ls"]);
	expect(planning.nodes[0]?.approval?.authority).toBe("human");

	// Before the approval: refused. A chat controller cannot approve it either.
	await expect(startWorkspaceFactoryFromPlan({ workspaceId, planDagId: dagId })).rejects.toThrow(
		"not been completed",
	);
	const gateId = waiting.gates.find((g) => g.disposition === "pending")?.id ?? "";
	expect(
		(
			await controller().execute({
				commandId: "chat-plan-approve",
				dagId,
				expectedVersion: waiting.version,
				command: { kind: "approve", gateId, reason: "chat says yes" },
			})
		).ok,
	).toBe(false);
	await expect(startWorkspaceFactoryFromPlan({ workspaceId, planDagId: dagId })).rejects.toThrow(
		"not been completed",
	);

	await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: `plan-approve-${serial++}`,
		expectedVersion: (await readWorkspaceDag(workspaceId, dagId)).version,
		command: { kind: "approve", gateId, reason: "Plan is fine" },
	});
	await until(dagId, (s) => s.nodes.every((n) => n.status === "completed"));

	const built = await startWorkspaceFactoryFromPlan({ workspaceId, planDagId: dagId });
	expect(built.kind).toBe("factory");
	const view = await readWorkspaceDag(workspaceId, built.dagId);
	expect(view.mode).toBe("paused");
	expect(view.nodes.map((n) => n.id)).toContain("api");
	expect(view.nodes.map((n) => n.id)).toContain("land");
	const definition = await definitionOf(built.dagId);
	expect(definition.nodes.find((n) => n.id === "release")?.approval?.authority).toBe("human");
	expect(definition.nodes.find((n) => n.id === "review")?.session?.model).toEqual({
		provider: "dag-wire-other",
		id: "reviewer",
	});
	// Building again from the same approved plan returns the same factory DAG.
	expect((await startWorkspaceFactoryFromPlan({ workspaceId, planDagId: dagId })).dagId).toBe(
		built.dagId,
	);
});

test("a plan that breaks the rules is rejected by the host even after a person approved it", async () => {
	const { dagId, waiting } = await plannedAndApproved({
		coders: [
			{ id: "a", task: "x", owns: ["src/**"] },
			{ id: "b", task: "y", owns: ["src/b/**"] },
		],
	});
	const gateId = waiting.gates.find((g) => g.disposition === "pending")?.id ?? "";
	await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: `bad-plan-approve-${serial++}`,
		expectedVersion: (await readWorkspaceDag(workspaceId, dagId)).version,
		command: { kind: "approve", gateId, reason: "ok" },
	});
	await until(dagId, (s) => s.nodes.every((n) => n.status === "completed"));
	await expect(startWorkspaceFactoryFromPlan({ workspaceId, planDagId: dagId })).rejects.toThrow(
		"may touch the same files",
	);
	// A DAG that is not a planning DAG is refused outright.
	const plain = await createDag();
	await expect(startWorkspaceFactoryFromPlan({ workspaceId, planDagId: plain })).rejects.toThrow(
		"not a planning DAG",
	);
	await expect(startWorkspaceFactoryFromPlan({ workspaceId, planDagId: "../x" })).rejects.toThrow(
		"Invalid dagId",
	);
});

// A factory-shaped DAG whose nodes only submit text, so a rejection can be made without worktrees: the
// gate report feeds the reviewer, the reviewer's findings feed the release, and the host's replan reads
// the factory marker on `release` and the plan run on `review`.
const planRun = (): PlanRun => ({
	title: "Add the thing",
	task: "Add the thing, carefully",
	target: "main",
	gateRetries: 1,
	notes: ["Departure noted"],
	roles: {
		coder: { model: fauxRef, thinkingLevel: "off" },
		reviewer: { model: otherRef, thinkingLevel: "off" },
		scout: { model: fauxRef, thinkingLevel: "off" },
	},
});

function rejectableFactory(
	options: { run?: PlanRun | null; marker?: boolean } = {},
): DagDefinition {
	const run = options.run === undefined ? planRun() : options.run;
	return {
		title: `Factory: Add the thing ${serial++}`,
		defaults: { tools: [] },
		maxConcurrent: 1,
		nodes: [
			{
				id: "gate-api",
				task: "report",
				outputs: { report: { kind: "text" } },
			},
			{
				id: "review",
				task: "review",
				session: { systemPrompt: run ? `Reviewer\n\n${encodePlanRun(run)}` : "Reviewer" },
				inputs: { "gate-api": { kind: "text" } },
				outputs: { findings: { kind: "json" } },
				approval: { authority: "human", question: "Answer the findings?" },
			},
			{
				id: "release",
				task: "release",
				session: {
					systemPrompt:
						options.marker === false
							? "Release"
							: `Release\n\n${encodeFactoryNode({ role: "release", sources: ["api"] })}`,
				},
				inputs: { review: { kind: "json" } },
				outputs: { summary: { kind: "text" } },
				approval: { authority: "human", question: "Land it?" },
			},
		],
		connections: [
			{
				id: "gate-to-review",
				kind: "data",
				from: { nodeId: "gate-api", output: "report" },
				to: { nodeId: "review", input: "gate-api" },
			},
			{
				id: "review-to-release",
				kind: "data",
				from: { nodeId: "review", output: "findings" },
				to: { nodeId: "release", input: "review" },
			},
		],
	};
}

const submit = (outputs: Record<string, unknown>) =>
	fauxAssistantMessage(fauxToolCall("dag_submit_result", { outputs: outputs as never }));

/** Runs the factory-shaped DAG until `at` waits for a person, then rejects that gate with `reason`. */
async function rejectedFactory(
	at: "review" | "release",
	reason: string,
	definition = rejectableFactory(),
	findings: unknown[] = [
		{ severity: "low", file: "src/a.ts", summary: "Missing test" },
		{ severity: "critical", file: "src/b.ts", summary: "Leaks the token" },
	],
): Promise<string> {
	const created = value(
		await owner().execute({
			commandId: `rf-${serial++}`,
			command: { kind: "create", definition },
		}),
	);
	const dagId = created.dagId;
	faux.setResponses([
		submit({ report: { kind: "text", text: "FAIL: lint reported 3 errors in api" } }),
		submit({ findings: { kind: "json", value: { findings } } }),
		submit({ summary: { kind: "text", text: "Release summary" } }),
	]);
	const decide = async (kind: "approve" | "reject", text: string, nodeId: string) => {
		const snapshot = await until(dagId, (s) =>
			s.gates.some((g) => g.target.nodeId === nodeId && g.disposition === "pending"),
		);
		const gate = snapshot.gates.find(
			(g) => g.target.nodeId === nodeId && g.disposition === "pending",
		);
		await executeWorkspaceDag({
			workspaceId,
			dagId,
			commandId: `rf-${kind}-${serial++}`,
			expectedVersion: snapshot.version,
			command: { kind, gateId: gate?.id ?? "", reason: text },
		});
	};
	const paused = await readWorkspaceDag(workspaceId, dagId);
	await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: `rf-resume-${serial++}`,
		expectedVersion: paused.version,
		command: { kind: "resume" },
	});
	if (at === "review") await decide("reject", reason, "review");
	else {
		await decide("approve", "Findings answered", "review");
		await decide("reject", reason, "release");
	}
	await until(dagId, (s) =>
		s.gates.some((g) => g.target.nodeId === at && g.disposition === "rejected"),
	);
	return dagId;
}

test("a rejected release is sent back to a new planning DAG with the reason, findings and gate verdicts", async () => {
	const dagId = await rejectedFactory("release", "The token leak must be fixed first");
	// The pane learns of the rejection from the projection, not by guessing.
	const view = await readWorkspaceDag(workspaceId, dagId);
	expect(view.nodes.find((n) => n.id === "release")?.rejected).toBe(true);
	expect(view.nodes.find((n) => n.id === "review")?.rejected).toBeUndefined();

	const result = await replanWorkspaceFactory({ workspaceId, dagId });
	expect(result).toMatchObject({ kind: "plan", notes: ["Departure noted"] });
	expect(result.dagId).not.toBe(dagId);
	// Nothing runs: the planning DAG is created paused and the planner has not started.
	const planning = await readWorkspaceDag(workspaceId, result.dagId);
	expect(planning.mode).toBe("paused");
	expect(planning.title).toBe("Replan: Add the thing");
	expect(planning.nodes).toHaveLength(1);
	expect(planning.nodes[0]).toMatchObject({ id: "planner", planner: true });
	expect(planning.nodes[0]?.outcome).toBeUndefined();

	const definition = await definitionOf(result.dagId);
	const task = definition.nodes[0]?.task ?? "";
	expect(task).toContain("Add the thing, carefully");
	expect(task).toContain("The token leak must be fixed first");
	expect(task).toContain("Leaks the token");
	expect(task).toContain("Missing test");
	expect(task.indexOf("Leaks the token")).toBeLessThan(task.indexOf("Missing test"));
	expect(task).toContain("gate-api: FAIL: lint reported 3 errors in api");
	expect(task).toContain(dagId);
	// The planner is read-only and its plan still needs a person's approval.
	expect(definition.nodes[0]?.session?.tools).toEqual(["read", "grep", "find", "ls"]);
	expect(definition.nodes[0]?.approval?.authority).toBe("human");

	// Roles, target, budget and the lineage are carried over from the rejected run.
	const run = parsePlanRun(definition.nodes[0]?.session?.systemPrompt);
	expect(run).toMatchObject({
		title: "Add the thing",
		task: "Add the thing, carefully",
		target: "main",
		gateRetries: 1,
		replanOf: dagId,
	});
	expect(run?.roles.coder.model).toEqual(fauxRef);
	expect(run?.roles.reviewer.model).toEqual(otherRef);

	// Replaying the same rejection returns the same planning DAG.
	expect((await replanWorkspaceFactory({ workspaceId, dagId })).dagId).toBe(result.dagId);
}, 90_000);

test("a rejected review gate can be replanned too, and a long reason and many findings stay bounded", async () => {
	const many = Array.from({ length: 40 }, (_, index) => ({
		severity: "medium",
		file: `src/file${index}.ts`,
		summary: `Finding number ${index} ${"y".repeat(150)}`,
	}));
	const reason = `${"Because. ".repeat(450)}END-OF-REASON`;
	expect(reason.length).toBeLessThan(4096);
	const dagId = await rejectedFactory("review", reason, rejectableFactory(), many);
	const result = await replanWorkspaceFactory({ workspaceId, dagId });
	const task = (await definitionOf(result.dagId)).nodes[0]?.task ?? "";
	expect(task.length).toBeLessThanOrEqual(8000);
	expect(task).toContain("Add the thing, carefully");
	expect(task).toContain("[truncated]");
	expect(task).not.toContain("END-OF-REASON");
	expect(task).not.toContain("Finding number 39");
	expect(task).toContain("review step");
}, 90_000);

test("a replan is refused for a DAG that is not a rejected, recoverable factory run", async () => {
	// Not a factory DAG at all.
	await expect(replanWorkspaceFactory({ workspaceId, dagId: await createDag() })).rejects.toThrow(
		"not a factory DAG",
	);
	// A factory DAG nobody rejected: its release has not even been decided.
	const open = value(
		await owner().execute({
			commandId: `rf-open-${serial++}`,
			command: { kind: "create", definition: rejectableFactory() },
		}),
	);
	await expect(replanWorkspaceFactory({ workspaceId, dagId: open.dagId })).rejects.toThrow(
		"No release or review was rejected",
	);
	// A rejection exists but the original run's settings are not in the DAG.
	const bare = await rejectedFactory("release", "No", rejectableFactory({ run: null }));
	await expect(replanWorkspaceFactory({ workspaceId, dagId: bare })).rejects.toThrow(
		"cannot be recovered",
	);
	// The release node carries no factory marker.
	const unmarked = await rejectedFactory("release", "No", rejectableFactory({ marker: false }));
	await expect(replanWorkspaceFactory({ workspaceId, dagId: unmarked })).rejects.toThrow(
		"not a factory DAG",
	);
	// The wire names no caller and no other field; ids are validated.
	const rejected = await rejectedFactory("release", "No");
	await expect(
		replanWorkspaceFactory({ workspaceId, dagId: rejected, caller: { kind: "owner" } }),
	).rejects.toThrow("Invalid DAG replan request");
	await expect(replanWorkspaceFactory({ workspaceId, dagId: "../x" })).rejects.toThrow(
		"Invalid dagId",
	);
	await expect(replanWorkspaceFactory({ workspaceId: "../x", dagId: rejected })).rejects.toThrow(
		"Invalid workspaceId",
	);
}, 90_000);

test("a replan whose stored models are gone is refused plainly", async () => {
	const run = planRun();
	run.roles.coder = { model: { provider: "gone", id: "model" }, thinkingLevel: "off" };
	const dagId = await rejectedFactory("release", "No", rejectableFactory({ run }));
	await expect(replanWorkspaceFactory({ workspaceId, dagId })).rejects.toMatchObject({
		code: "DAG_REJECTED",
		message: expect.stringContaining("is not available"),
	});
}, 90_000);

test("a factory started by a person records its run so a rejection can be replanned", async () => {
	const result = await startWorkspaceFactory({ ...startBase(), coders: twoCoders });
	const definition = await definitionOf(result.dagId);
	const run = parsePlanRun(definition.nodes.find((n) => n.id === "review")?.session?.systemPrompt);
	expect(run).toMatchObject({ title: "Add the thing", task: "Add the thing", target: "main" });
	expect(run?.roles.reviewer.model).toEqual(otherRef);
}, 90_000);
