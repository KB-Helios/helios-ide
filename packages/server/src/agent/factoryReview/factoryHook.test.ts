import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";

setDefaultTimeout(120_000);

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { closeAllDags, dagServiceFor } from "../dag";
import { buildFactoryDefinition } from "../factory";
import { factoryModels, factoryReviewHook, RELEASE_REVIEW_INPUT } from "./factoryHook";
import { resolveRoleModels } from "./roles";

const coderModel = { provider: "hook-coder-faux", id: "claude-coder" };
const reviewerModel = { provider: "hook-review-faux", id: "gpt-reviewer" };
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
const root = mkdtempSync(join(tmpdir(), "trhook-"));
let runtime: ModelRuntime;
const prior: Record<string, string | undefined> = {};

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString();
}

function makeRepo(): string {
	const repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "t@example.com");
	git(repo, "config", "user.name", "T");
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ name: "demo", scripts: { test: 'bun -e "process.exit(0)"' } }),
	);
	writeFileSync(join(repo, "bun.lock"), "");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "init");
	return repo;
}

beforeAll(async () => {
	for (const key of ["THINKRAIL_DATA_DIR", "PI_CODING_AGENT_DIR", "PI_OFFLINE"])
		prior[key] = process.env[key];
	process.env.THINKRAIL_DATA_DIR = join(root, "data");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.PI_OFFLINE = "1";
	runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const [model, core, reasoning] of [
		[coderModel, coderFaux, false],
		[reviewerModel, reviewerFaux, true],
	] as const)
		runtime.registerProvider(model.provider, {
			api: core.api,
			baseUrl: "http://faux.local",
			apiKey: "synthetic",
			streamSimple: core.streamSimple,
			models: [
				{
					id: model.id,
					name: model.id,
					reasoning,
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
	for (const [key, value] of Object.entries(prior)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

function value<T>(result: DagResult<T>): T {
	if (!result.ok) throw new Error(JSON.stringify(result.error));
	return result.value;
}

function bind(workspaceId: string, repo: string, caller: "owner" | "human"): DagClient {
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
			model: coderModel,
			isProjectTrusted: () => true,
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

const text = (port: string, body: string) =>
	fauxAssistantMessage(
		fauxToolCall("dag_submit_result", { outputs: { [port]: { kind: "text", text: body } } }),
	);
const call = (name: string, args: Record<string, string> = {}) =>
	fauxAssistantMessage(fauxToolCall(name, args));

test("the template's reviewer runs on another family over the worktrees and holds release for a person", async () => {
	const workspaceId = "hookws";
	const repo = makeRepo();
	const reviewerTools: string[] = [];
	const coderScript: FauxResponseFactory = async (context) => {
		const seen = JSON.stringify(context);
		const turn = context.messages.filter((message) => message.role === "assistant").length;
		if (/"role\\":\\"coder\\"/.test(seen))
			return (
				[
					call("factory_write", { path: "src/feature.txt", content: "feature\n" }),
					call("factory_run_gates"),
				][turn] ?? text("summary", "done")
			);
		if (/"role\\":\\"gate\\"/.test(seen))
			return turn === 0 ? call("factory_run_gates") : text("report", "gates ok");
		if (/"role\\":\\"integration\\"/.test(seen))
			return turn === 0 ? call("factory_run_gates") : text("report", "combined ok");
		if (/"role\\":\\"release\\"/.test(seen))
			return turn === 0 ? call("factory_report") : text("summary", "ready");
		if (/"role\\":\\"land\\"/.test(seen))
			return turn === 0 ? call("factory_land") : text("landed", "landed");
		throw new Error(`Unscripted coder-family node: ${seen.slice(0, 200)}`);
	};
	const reviewerScript: FauxResponseFactory = async (context) => {
		const turn = context.messages.filter((message) => message.role === "assistant").length;
		if (turn === 0) {
			reviewerTools.push("factory_diff");
			return call("factory_diff");
		}
		return fauxAssistantMessage(
			fauxToolCall("dag_submit_result", {
				outputs: {
					findings: {
						kind: "json",
						value: {
							findings: [{ severity: "low", file: "src/feature.txt", summary: "No test" }],
						},
					},
				},
			}),
		);
	};
	coderFaux.setResponses(Array.from({ length: 30 }, () => coderScript));
	reviewerFaux.setResponses(Array.from({ length: 10 }, () => reviewerScript));

	const { roles } = resolveRoleModels(
		[
			{
				provider: coderModel.provider,
				id: coderModel.id,
				reasoning: false,
				contextWindow: 100_000,
				cost: { input: 0, output: 0 },
			},
			{
				provider: reviewerModel.provider,
				id: reviewerModel.id,
				reasoning: true,
				contextWindow: 100_000,
				cost: { input: 0, output: 0 },
			},
		],
		{ preferred: coderModel },
	);
	expect(roles.reviewer.model).toEqual(reviewerModel);
	const definition = buildFactoryDefinition({
		title: "Reviewed feature",
		target: "main",
		coders: [{ id: "coder", task: "Add the feature" }],
		models: factoryModels(roles),
		beforeRelease: factoryReviewHook({ roles }),
	});
	const release = definition.nodes.find((node) => node.id === "release");
	expect(release?.inputs?.[RELEASE_REVIEW_INPUT]).toEqual({ kind: "json" });
	// The combined gate run is a mechanical node on the scout; the reviewer waits for it, not for each gate.
	const integrate = definition.nodes.find((node) => node.id === "integrate");
	expect(integrate?.session?.model).toEqual(roles.scout.model);
	const reviewer = definition.nodes.find((node) => node.id === "review");
	expect(Object.keys(reviewer?.inputs ?? {})).toEqual(["integrate"]);
	expect(definition.connections.some((connection) => connection.id === "integrate-to-review")).toBe(
		true,
	);

	const owner = bind(workspaceId, repo, "owner");
	const human = bind(workspaceId, repo, "human");
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

	// The review gate comes first; release has not started and nothing is on main.
	const reviewWait = await until(owner, dagId, (state) =>
		state.gates.some((gate) => gate.disposition === "pending"),
	);
	const status = (state: DagSnapshot) =>
		Object.fromEntries(state.nodes.map((node) => [node.id, node.status]));
	expect(status(reviewWait).review).toBe("waiting-approval");
	expect(status(reviewWait).release).toBe("pending");
	expect(reviewerTools).toEqual(["factory_diff"]);
	const reviewNode = reviewWait.nodes.find((node) => node.id === "review");
	expect(reviewNode?.outcome?.details).toMatchObject({ model: "hook-review-faux/gpt-reviewer" });
	expect(existsSync(join(repo, "src", "feature.txt"))).toBe(false);

	const reviewGate = reviewWait.gates.find((gate) => gate.disposition === "pending");
	value(
		await human.execute({
			commandId: "approve-review",
			dagId,
			expectedVersion: reviewWait.version,
			command: { kind: "approve", gateId: reviewGate?.id ?? "", reason: "Finding accepted" },
		}),
	);

	// Then the release gate; landing still waits for it.
	const releaseWait = await until(owner, dagId, (state) =>
		state.nodes.some((node) => node.id === "release" && node.status === "waiting-approval"),
	);
	expect(status(releaseWait).land).toBe("pending");
	const releaseGate = releaseWait.gates.find((gate) => gate.disposition === "pending");
	value(
		await human.execute({
			commandId: "approve-release",
			dagId,
			expectedVersion: releaseWait.version,
			command: { kind: "approve", gateId: releaseGate?.id ?? "", reason: "Ship it" },
		}),
	);
	await until(owner, dagId, (state) => state.nodes.every((node) => node.status === "completed"));
	expect(readFileSync(join(repo, "src", "feature.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
		"feature\n",
	);
});
