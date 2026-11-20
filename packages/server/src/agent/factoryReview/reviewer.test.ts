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
import type { DagClient, DagDefinition, DagResult, DagSnapshot, JsonValue } from "pi-dag";
import { closeAllDags, dagServiceFor } from "../dag";
import { executeWorkspaceDag, readWorkspaceDag, readWorkspaceReview, toDagView } from "../dagWire";
import { configurePiRuntime } from "../piRuntime";
import { buildReviewerPiece, parseFindings, REVIEWER_TOOLS } from "./reviewer";
import {
	availableFactoryModels,
	FactoryRoleError,
	modelFamily,
	resolveFactoryRoles,
	resolveRoleModels,
} from "./roles";

const coderModel = { provider: "review-coder-faux", id: "claude-coder" };
const reviewerModel = { provider: "review-other-faux", id: "gpt-reviewer" };
const coderFaux = createFauxCore({
	provider: coderModel.provider,
	api: coderModel.provider,
	tokensPerSecond: 100_000,
});
const reviewerFaux = createFauxCore({
	provider: reviewerModel.provider,
	api: reviewerModel.provider,
	tokensPerSecond: 100_000,
});
const root = mkdtempSync(join(tmpdir(), "trreview-"));
const workspaceId = "reviewws";
let runtime: ModelRuntime;
let priorDataDir: string | undefined;
let priorAgentDir: string | undefined;
let priorOffline: string | undefined;
let serial = 0;

function register(provider: string, core: typeof coderFaux, id: string, reasoning: boolean) {
	runtime.registerProvider(provider, {
		api: core.api,
		baseUrl: "http://faux.local",
		apiKey: "synthetic",
		streamSimple: core.streamSimple,
		models: [
			{
				id,
				name: id,
				reasoning,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			},
		],
	});
}

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
				name: "review",
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
	register(coderModel.provider, coderFaux, coderModel.id, false);
	register(reviewerModel.provider, reviewerFaux, reviewerModel.id, true);
	configurePiRuntime(runtime);
});

afterEach(async () => {
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
		execution: { kind: "runtime", modelRuntime: runtime, cwd: join(root, "checkout") },
	});
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

const submit = (outputs: Record<string, JsonValue>) =>
	fauxAssistantMessage(fauxToolCall("dag_submit_result", { outputs }));

/** code -> review (other family, read-only, human gate) -> land, built exactly as a template would. */
async function factoryDag(): Promise<{ dagId: string; reviewerSelection: string }> {
	const { roles } = await resolveFactoryRoles({ preferred: coderModel, include: fauxOnly });
	const piece = buildReviewerPiece({
		reviewer: roles.reviewer,
		diff: { nodeId: "code", output: "diff" },
		release: "land",
	});
	const definition: DagDefinition = {
		title: `Reviewed release ${serial++}`,
		defaults: { tools: [] },
		maxConcurrent: 1,
		nodes: [
			{
				id: "code",
				task: "Implement and merge",
				session: { model: roles.coder.model, thinkingLevel: roles.coder.thinkingLevel },
				outputs: { diff: { kind: "text" } },
			},
			...piece.nodes,
			{
				id: "land",
				task: "Land the change",
				session: { model: roles.coder.model, thinkingLevel: roles.coder.thinkingLevel },
				outputs: { landed: { kind: "text" } },
				approval: { authority: "human", question: "Land it?" },
			},
		],
		connections: piece.connections,
	};
	const created = value(
		await owner().execute({
			commandId: `create-${serial++}`,
			command: { kind: "create", definition },
		}),
	);
	return {
		dagId: created.dagId,
		reviewerSelection: `${roles.reviewer.model.provider}/${roles.reviewer.model.id}`,
	};
}

async function resume(dagId: string) {
	const view = await readWorkspaceDag(workspaceId, dagId);
	return executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: `resume-${serial++}`,
		expectedVersion: view.version,
		command: { kind: "resume" },
	});
}

function fauxOnly(model: { provider: string }): boolean {
	return model.provider.endsWith("-faux");
}

const finding = { severity: "high", file: "src/a.ts", summary: "Unchecked null" } as const;

test("roles pick the reviewer from another family than the coder", async () => {
	const { roles, notes } = await resolveFactoryRoles({ preferred: coderModel, include: fauxOnly });
	expect(roles.coder.model).toEqual(coderModel);
	expect(roles.reviewer.model).toEqual(reviewerModel);
	expect(roles.reviewer.family).not.toBe(roles.coder.family);
	expect(roles.reviewer.thinkingLevel).toBe("high");
	expect(roles.coder.thinkingLevel).toBe("off");
	expect(notes).toEqual([]);
	expect((await availableFactoryModels()).map((m) => m.id)).toContain("gpt-reviewer");
});

test("with a single family the reviewer fails loudly unless a recorded fallback is allowed", () => {
	const only = [
		{ provider: "a", id: "claude-x" },
		{ provider: "b", id: "claude-y" },
	];
	expect(modelFamily(only[0] as (typeof only)[0])).toBe(modelFamily(only[1] as (typeof only)[0]));
	expect(() => resolveRoleModels(only)).toThrow(FactoryRoleError);
	const fallback = resolveRoleModels(only, { allowSameFamilyReviewer: true });
	expect(fallback.notes).toHaveLength(1);
	expect(fallback.notes[0]).toMatchObject({ role: "reviewer", kind: "same-family-reviewer" });
	expect(() => resolveRoleModels([])).toThrow("No model is available");
	expect(() =>
		resolveRoleModels(only, { overrides: { coder: { provider: "zzz", id: "nope" } } }),
	).toThrow("not available");
});

test("an override wins, but a same-family reviewer override is still refused", () => {
	const claude = { provider: "a", id: "claude-x" };
	const gemini = { provider: "c", id: "gemini-z" };
	const pool = [claude, { provider: "b", id: "gpt-y" }, gemini];
	const chosen = resolveRoleModels(pool, { preferred: claude, overrides: { reviewer: gemini } });
	expect(chosen.roles.reviewer.model).toEqual(gemini);
	expect(() =>
		resolveRoleModels(pool, { preferred: claude, overrides: { reviewer: claude } }),
	).toThrow(FactoryRoleError);
});

test("the reviewer node is read-only, on its own model, with a human gate", () => {
	const { roles } = resolveRoleModels([coderModel, { ...reviewerModel, reasoning: true }], {
		preferred: coderModel,
	});
	const piece = buildReviewerPiece({
		reviewer: roles.reviewer,
		diff: { nodeId: "join", output: "merged" },
		release: "land",
	});
	const node = piece.nodes[0];
	expect(node?.session?.model).toEqual(reviewerModel);
	expect(node?.session?.tools).toEqual([...REVIEWER_TOOLS]);
	for (const mutating of ["bash", "write", "edit"])
		expect(node?.session?.tools).not.toContain(mutating);
	expect(node?.approval?.authority).toBe("human");
	expect(node?.outputs).toEqual({ findings: { kind: "json" } });
	expect(piece.connections).toEqual([
		{
			id: "review-diff",
			kind: "data",
			from: { nodeId: "join", output: "merged" },
			to: { nodeId: "review", input: "diff" },
		},
		{
			id: "review-before-release",
			kind: "control",
			from: "review",
			to: "land",
			allowSkipped: false,
		},
	]);
});

test("findings are parsed strictly and bounded", () => {
	expect(parseFindings({ findings: [] })).toEqual({
		valid: true,
		total: 0,
		findings: [],
		truncated: false,
	});
	expect(parseFindings({ findings: [finding] }).findings).toEqual([finding]);
	expect(parseFindings({ findings: [{ ...finding, severity: "huge" }] }).valid).toBe(false);
	expect(parseFindings({ findings: [finding, 7] }).valid).toBe(false);
	expect(parseFindings("nope").valid).toBe(false);
	const many = parseFindings({ findings: Array.from({ length: 80 }, () => finding) });
	expect(many).toMatchObject({ valid: true, total: 80, truncated: true });
	expect(many.findings).toHaveLength(50);
});

test("the other family reviews the merged diff; release stays blocked until a human approves", async () => {
	const { dagId, reviewerSelection } = await factoryDag();
	expect(reviewerSelection).toBe("review-other-faux/gpt-reviewer");
	coderFaux.setResponses([submit({ diff: { kind: "text", text: "diff --git a/src/a.ts" } })]);
	reviewerFaux.setResponses([
		submit({ findings: { kind: "json", value: { findings: [finding] } } }),
	]);
	await resume(dagId);

	const waiting = await until(dagId, (s) => s.nodes.some((n) => n.status === "waiting-approval"));
	const status = Object.fromEntries(waiting.nodes.map((n) => [n.id, n.status]));
	expect(status).toEqual({ code: "completed", review: "waiting-approval", land: "pending" });
	expect(reviewerFaux.state.callCount).toBe(1);
	const coderCalls = coderFaux.state.callCount;

	// The node log: which model, how many tokens, how it ended - per node, from pi-dag's own outcome.
	const view = toDagView(waiting);
	const byId = Object.fromEntries(view.nodes.map((n) => [n.id, n]));
	expect(byId.code).toMatchObject({
		model: "review-coder-faux/claude-coder",
		outcome: "completed",
	});
	expect(byId.review).toMatchObject({
		model: "review-other-faux/gpt-reviewer",
		thinkingLevel: "high",
		outcome: "completed",
	});
	expect(byId.review?.usage?.turns).toBeGreaterThan(0);
	expect(byId.land?.model).toBeUndefined();

	const findings = await readWorkspaceReview(workspaceId, dagId, "review");
	expect(findings).toMatchObject({
		nodeId: "review",
		valid: true,
		total: 1,
		disposition: "pending",
		model: "review-other-faux/gpt-reviewer",
	});
	expect(findings?.findings).toEqual([finding]);
	await expect(readWorkspaceReview(workspaceId, dagId, "code")).rejects.toMatchObject({
		code: "DAG_REJECTED",
	});

	// A chat controller can never release it; only the UI's human can.
	const gate = (await readWorkspaceDag(workspaceId, dagId)).gates[0];
	const refused = await dagServiceFor(workspaceId)
		.bind({
			caller: { kind: "controller", sessionId: "chat" },
			signal: new AbortController().signal,
		})
		.execute({
			commandId: "chat-approve",
			dagId,
			expectedVersion: waiting.version,
			command: { kind: "approve", gateId: gate?.id ?? "", reason: "chat says yes" },
		});
	expect(refused.ok).toBe(false);
	await Bun.sleep(30);
	expect((await until(dagId, () => true)).nodes.find((n) => n.id === "land")?.status).toBe(
		"pending",
	);
	expect(coderFaux.state.callCount).toBe(coderCalls);

	coderFaux.setResponses([submit({ landed: { kind: "text", text: "landed" } })]);
	const current = await readWorkspaceDag(workspaceId, dagId);
	await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: "ui-approve-review",
		expectedVersion: current.version,
		command: { kind: "approve", gateId: gate?.id ?? "", reason: "Findings answered" },
	});
	const released = await until(
		dagId,
		(s) => s.nodes.find((n) => n.id === "land")?.status === "waiting-approval",
	);
	expect(released.nodes.find((n) => n.id === "review")?.status).toBe("completed");
	expect(coderFaux.state.callCount).toBe(coderCalls + 1);
}, 30_000);

test("a rejected review keeps the release blocked", async () => {
	const { dagId } = await factoryDag();
	coderFaux.setResponses([submit({ diff: { kind: "text", text: "diff" } })]);
	reviewerFaux.setResponses([submit({ findings: { kind: "json", value: { findings: [] } } })]);
	await resume(dagId);
	const waiting = await until(dagId, (s) => s.nodes.some((n) => n.status === "waiting-approval"));
	// Zero findings still need the human gate: release is always a person's.
	expect(await readWorkspaceReview(workspaceId, dagId, "review")).toMatchObject({
		valid: true,
		total: 0,
	});
	const calls = coderFaux.state.callCount;
	const view = await readWorkspaceDag(workspaceId, dagId);
	await executeWorkspaceDag({
		workspaceId,
		dagId,
		commandId: "ui-reject-review",
		expectedVersion: view.version,
		command: { kind: "reject", gateId: view.gates[0]?.id ?? "", reason: "Finding 2 is unanswered" },
	});
	await Bun.sleep(50);
	const after = value(await owner().getDag({ dagId }));
	expect(waiting.gates.length).toBeGreaterThan(0);
	expect(after.nodes.find((n) => n.id === "review")?.status).not.toBe("completed");
	expect(after.nodes.find((n) => n.id === "land")?.status).toBe("pending");
	expect(coderFaux.state.callCount).toBe(calls);
}, 30_000);
