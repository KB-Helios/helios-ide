import { open, readFile } from "node:fs/promises";
import {
	DAG_HISTORY_MAX_PAGE,
	DAG_OUTPUT_IMAGE_MAX_BYTES,
	DAG_OUTPUT_MAX_BYTES,
	type DagExecuteRequest,
	type DagHistoryItem,
	type DagHistoryPage,
	type DagListItem,
	type DagOutputView,
	type DagQueueView,
	type DagReviewView,
	type DagStartResult,
	type DagView,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import type {
	DagCaller,
	DagClient,
	DagCommandRequest,
	DagFailure,
	DagResult,
	DagSnapshot,
} from "pi-dag";
import { getWorkspace } from "../workspaces";
import { sessionlessProjectTrust } from "./agentSessionManager";
import { dagServiceFor } from "./dag";
import { previewArtifact } from "./dagArtifact";
import { cancelPendingDagChanges, publishDagChangedNow } from "./dagChanges";
import { replanFactory, startFactory, startFactoryFromPlan } from "./dagStart";
import { factoryQueueOf, globalFactoryQueue, isPlannerNode } from "./factory";
import { FINDINGS_PORT, isReviewerNode, parseFindings } from "./factoryReview/reviewer";
import { getPiRuntime } from "./piRuntime";
import { isHostResourceId } from "./resourceIdentity";

/**
 * Wire surface of the workspace DAGs (`dag.list` / `dag.get` / `dag.execute`). Every call acts as the
 * one local desktop user: the caller is hard-wired to `human` here and no wire field can choose it,
 * so a chat model or a remote payload never becomes the human that human-only gates require.
 */
export const DAG_OPERATOR_ID = "thinkrail-ui";
const HUMAN: DagCaller = { kind: "human", operatorId: DAG_OPERATOR_ID };
const DAG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Bindings live as long as the host: shutdown revokes them, the next start re-arms. */
let hostLifetime = new AbortController();
export function stopDagWire(): void {
	cancelPendingDagChanges();
	hostLifetime.abort();
	hostLifetime = new AbortController();
}

function workspaceCwd(workspaceId: string): string {
	if (!isHostResourceId(workspaceId)) throw new Error("Invalid workspaceId");
	try {
		return getWorkspace(workspaceId).worktreePath;
	} catch {
		throw new CodedError("RESOURCE_UNAVAILABLE", "Workspace unavailable");
	}
}

function dagIdOf(value: unknown): string {
	if (typeof value !== "string" || !DAG_ID.test(value)) throw new Error("Invalid dagId");
	return value;
}

function unwrap<T>(result: DagResult<T>): T {
	if (result.ok) return result.value;
	throw dagError(result.error);
}

function dagError(failure: DagFailure): CodedError {
	const stale = failure.code === "stale-version" || failure.code === "stale-target";
	return new CodedError(stale ? "DAG_STALE" : "DAG_REJECTED", failure.message);
}

function readClient(workspaceId: string): DagClient {
	workspaceCwd(workspaceId);
	return dagServiceFor(workspaceId).bind({ caller: HUMAN, signal: hostLifetime.signal });
}

/**
 * Commands can admit work (resume, an approval releasing a downstream node, retry), so they carry an
 * execution context. A DAG is not a parent chat: it runs on the host's current model runtime, in the
 * DAG's own recorded cwd (pi-dag substitutes the cwd saved at creation; the workspace worktree is the
 * fallback it validates). Project trust is the sessionless form of what a chat session checks (pi's
 * folder trust and the workspace's resource trust, re-read per call); factory gates run only when it
 * is true, so an untrusted project still refuses them.
 */
async function commandClient(workspaceId: string): Promise<DagClient> {
	const cwd = workspaceCwd(workspaceId);
	return dagServiceFor(workspaceId).bind({
		caller: HUMAN,
		signal: hostLifetime.signal,
		execution: {
			kind: "runtime",
			modelRuntime: await getPiRuntime(),
			cwd,
			isProjectTrusted: sessionlessProjectTrust(workspaceId, cwd),
		},
	});
}

/**
 * What a node's latest run used, read from pi-dag's durable outcome: the effective model and thinking
 * level, token usage and cost, duration and how it ended. Nothing is derived or estimated here, and a
 * node that has not run projects nothing. This is also the factory's per-node log: the outcome is
 * persisted with the DAG snapshot, so no second store exists.
 */
function nodeRun(
	outcome: DagSnapshot["nodes"][number]["outcome"],
): Partial<DagView["nodes"][number]> {
	if (!outcome) return {};
	const { details } = outcome;
	return {
		outcome: outcome.status,
		...(details.model === undefined ? {} : { model: details.model }),
		...(details.thinkingLevel === undefined ? {} : { thinkingLevel: details.thinkingLevel }),
		durationMs: details.durationMs,
		usage: {
			input: details.usage.input,
			output: details.usage.output,
			cacheRead: details.usage.cacheRead,
			cacheWrite: details.usage.cacheWrite,
			cost: details.usage.cost,
			turns: details.usage.turns,
		},
	};
}

/** A person rejected the node's latest approval gate and no newer gate has been decided or opened. */
function isRejected(snapshot: DagSnapshot, nodeId: string): boolean {
	const latest = snapshot.gates
		.filter((gate) => gate.kind === "approval" && gate.target.nodeId === nodeId)
		.sort(
			(a, b) => a.target.attempt - b.target.attempt || a.target.activation - b.target.activation,
		)
		.at(-1);
	return latest?.disposition === "rejected" && latest.decision?.actor.kind === "human";
}

export function toDagView(snapshot: DagSnapshot): DagView {
	const known = new Set(snapshot.nodes.map((node) => node.id));
	const edges: DagView["edges"] = [];
	for (const connection of snapshot.connections) {
		const from = connection.kind === "data" ? connection.from.nodeId : connection.from;
		const to = connection.kind === "data" ? connection.to.nodeId : connection.to;
		if (typeof from === "string" && known.has(from) && known.has(to)) edges.push({ from, to });
	}
	return {
		dagId: snapshot.dagId,
		title: snapshot.title,
		version: snapshot.version,
		mode: snapshot.mode,
		lifecycle: snapshot.lifecycle,
		executionOwner: snapshot.executionOwner,
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		nodes: snapshot.nodes.map((node) => ({
			id: node.id,
			status: node.status,
			held: node.held,
			task: node.task.preview,
			...(node.attempt === undefined ? {} : { attempt: node.attempt }),
			...(node.activation === undefined ? {} : { activation: node.activation }),
			...(isReviewerNode(node.outputs) ? { reviewer: true as const } : {}),
			...(isPlannerNode(node.outputs) ? { planner: true as const } : {}),
			...(isRejected(snapshot, node.id) ? { rejected: true as const } : {}),
			...(node.proposalId && node.outputs && Object.keys(node.outputs).length
				? { outputs: Object.keys(node.outputs) }
				: {}),
			...nodeRun(node.outcome),
		})),
		edges,
		gates: snapshot.gates
			.filter((gate) => gate.disposition === "pending")
			.map((gate) => ({
				id: gate.id,
				kind: gate.kind,
				authority: gate.authority,
				question: gate.question.preview,
				target: {
					nodeId: gate.target.nodeId,
					attempt: gate.target.attempt,
					activation: gate.target.activation,
				},
			})),
	};
}

export async function listWorkspaceDags(workspaceId: string): Promise<DagListItem[]> {
	const client = readClient(workspaceId);
	const items: DagListItem[] = [];
	let cursor: string | undefined;
	do {
		const page = unwrap(await client.listDags(cursor ? { cursor } : {}));
		for (const summary of page.items) {
			const view = toDagView(unwrap(await client.getDag({ dagId: summary.dagId })));
			items.push({
				dagId: view.dagId,
				title: view.title,
				version: view.version,
				mode: view.mode,
				lifecycle: view.lifecycle,
				updatedAt: view.updatedAt,
				pendingGates: view.gates.length,
			});
		}
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}

/** Running and queued worker turns across the workspace's DAGs against its cap. */
export function readWorkspaceQueue(workspaceId: string): DagQueueView {
	workspaceCwd(workspaceId);
	dagServiceFor(workspaceId);
	const queue = factoryQueueOf(workspaceId);
	if (!queue) throw new CodedError("RESOURCE_UNAVAILABLE", "Workspace unavailable");
	return { ...queue, global: globalFactoryQueue() };
}

export async function readWorkspaceDag(workspaceId: string, dagId: string): Promise<DagView> {
	return toDagView(unwrap(await readClient(workspaceId).getDag({ dagId: dagIdOf(dagId) })));
}

const TEXT_MAX = 1024 * 1024;

function str(value: unknown, what: string, max = 4096): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max)
		throw new Error(`Invalid ${what}`);
	return value;
}

function positive(value: unknown, what: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error(`Invalid ${what}`);
	return value;
}

/**
 * Narrows a wire command to the whitelisted subset and rebuilds it field by field, so nothing the
 * client adds (a caller, a target kind outside the whitelist) reaches pi-dag.
 */
export function toDagCommand(
	raw: unknown,
): Extract<DagCommandRequest, { dagId: string }>["command"] {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid command");
	const c = raw as Record<string, unknown>;
	const only = (...keys: string[]) => {
		if (Object.keys(c).some((key) => key !== "kind" && !keys.includes(key)))
			throw new Error("Invalid command");
	};
	switch (c.kind) {
		case "pause":
		case "resume":
			only();
			return { kind: c.kind };
		case "interrupt":
			only();
			return { kind: "interrupt", target: { kind: "dag" } };
		case "cancel":
			only("nodeId");
			return {
				kind: "cancel",
				target:
					c.nodeId === undefined
						? { kind: "dag" }
						: { kind: "node", nodeId: str(c.nodeId, "nodeId", 128) },
			};
		case "retry":
			only("nodeId", "attempt");
			return {
				kind: "retry",
				target: { nodeId: str(c.nodeId, "nodeId", 128), attempt: positive(c.attempt, "attempt") },
			};
		case "continue":
			only("nodeId", "attempt", "activation");
			return {
				kind: "continue",
				target: {
					nodeId: str(c.nodeId, "nodeId", 128),
					attempt: positive(c.attempt, "attempt"),
					activation: positive(c.activation, "activation"),
				},
			};
		case "approve":
		case "reject":
			only("gateId", "reason");
			return {
				kind: c.kind,
				gateId: str(c.gateId, "gateId", 128),
				reason: str(c.reason, "reason"),
			};
		case "answer":
			only("gateId", "text");
			return {
				kind: "answer",
				gateId: str(c.gateId, "gateId", 128),
				value: str(c.text, "answer", TEXT_MAX),
			};
		default:
			throw new Error("Unsupported DAG command");
	}
}

export async function executeWorkspaceDag(params: unknown): Promise<{ dag: DagView }> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid DAG request");
	const p = params as Partial<Record<keyof DagExecuteRequest, unknown>>;
	const allowed = ["workspaceId", "dagId", "commandId", "expectedVersion", "command"];
	if (Object.keys(p).some((key) => !allowed.includes(key))) throw new Error("Invalid DAG request");
	if (!isHostResourceId(p.workspaceId)) throw new Error("Invalid workspaceId");
	const workspaceId = p.workspaceId;
	const dagId = dagIdOf(p.dagId);
	const commandId = str(p.commandId, "commandId", 128);
	const expectedVersion = positive(p.expectedVersion, "expectedVersion");
	const command = toDagCommand(p.command);
	const client = await commandClient(workspaceId);
	unwrap(await client.execute({ commandId, dagId, expectedVersion, command }));
	publishDagChangedNow({ workspaceId, dagId });
	return { dag: toDagView(unwrap(await client.getDag({ dagId }))) };
}

const FINDINGS_MAX_BYTES = 256 * 1024;

/**
 * The reviewer's findings for one node: the human-read-only `dag.review`. It serves a single declared
 * output port (`findings`) of a node that declares exactly that port, bounded in size and in findings
 * returned, and never a path, another port or an arbitrary output. `null` until the node submitted.
 */
export async function readWorkspaceReview(
	workspaceId: string,
	dagId: string,
	nodeId: string,
): Promise<DagReviewView | null> {
	const id = dagIdOf(dagId);
	str(nodeId, "nodeId", 128);
	const client = readClient(workspaceId);
	const snapshot = unwrap(await client.getDag({ dagId: id }));
	const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
	if (!node) throw new CodedError("RESOURCE_UNAVAILABLE", "Node unavailable");
	if (!isReviewerNode(node.outputs)) throw new CodedError("DAG_REJECTED", "Node is not a reviewer");
	if (!node.proposalId) return null;
	const output = unwrap(
		await client.getOutput({ dagId: id, proposalId: node.proposalId, name: FINDINGS_PORT }),
	);
	let parsed: ReturnType<typeof parseFindings>;
	if (output.value.kind !== "json" || output.value.file.sizeBytes > FINDINGS_MAX_BYTES)
		parsed = parseFindings(undefined);
	else {
		try {
			parsed = parseFindings(JSON.parse(await readFile(output.value.file.localPath, "utf8")));
		} catch {
			parsed = parseFindings(undefined);
		}
	}
	return {
		nodeId,
		proposalId: node.proposalId,
		disposition: output.disposition,
		...parsed,
		...(node.outcome?.details.model ? { model: node.outcome.details.model } : {}),
	};
}

function pageLimit(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error("Invalid limit");
	return Math.min(value, DAG_HISTORY_MAX_PAGE);
}

/**
 * The human-read-only `dag.history`: pi-dag's version-pinned event pages, oldest first, reduced to a
 * manifest (event kind, version, time, caller kind and target). Captured bodies and their paths are
 * never part of a row.
 */
export async function readWorkspaceHistory(
	workspaceId: string,
	dagId: string,
	cursor?: unknown,
	limit?: unknown,
): Promise<DagHistoryPage> {
	const id = dagIdOf(dagId);
	if (
		cursor !== undefined &&
		(typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4096)
	)
		throw new Error("Invalid cursor");
	const size = pageLimit(limit);
	const page = unwrap(
		await readClient(workspaceId).listHistory({
			dagId: id,
			limit: size ?? 20,
			...(cursor ? { cursor } : {}),
		}),
	);
	const items: DagHistoryItem[] = page.items.map((entry) => ({
		id: entry.id,
		version: entry.version,
		at: entry.at,
		kind: entry.kind,
		...(entry.actor ? { actor: entry.actor.kind } : {}),
		...(entry.target
			? {
					target: {
						nodeId: entry.target.nodeId,
						attempt: entry.target.attempt,
						activation: entry.target.activation,
					},
				}
			: {}),
	}));
	return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

/** At most `max` leading bytes of a file, without reading the rest of a large one. */
async function readHead(path: string, max: number): Promise<{ bytes: Buffer; truncated: boolean }> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(max + 1);
		const { bytesRead } = await handle.read(buffer, 0, max + 1, 0);
		return { bytes: buffer.subarray(0, Math.min(bytesRead, max)), truncated: bytesRead > max };
	} finally {
		await handle.close();
	}
}

/**
 * The human-read-only `dag.output`: one declared output of a node's current proposal. The name must be
 * one the node declares and the text is bounded to `DAG_OUTPUT_MAX_BYTES`. An artifact output is a
 * hash-verified preview of pi-dag's captured payload (see `previewArtifact`): base name and media type,
 * text-like content as `text`, a small image as base64, anything else described only. Never a path, another node's proposal or a transcript. `null` until the node submitted.
 */
export async function readWorkspaceOutput(
	workspaceId: string,
	dagId: string,
	nodeId: string,
	name: string,
	/** Tests lower the bound; the wire always uses `DAG_OUTPUT_MAX_BYTES`. */
	maxBytes = DAG_OUTPUT_MAX_BYTES,
	imageMaxBytes = DAG_OUTPUT_IMAGE_MAX_BYTES,
): Promise<DagOutputView | null> {
	const id = dagIdOf(dagId);
	str(nodeId, "nodeId", 128);
	str(name, "name", 128);
	const client = readClient(workspaceId);
	const snapshot = unwrap(await client.getDag({ dagId: id }));
	const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
	if (!node) throw new CodedError("RESOURCE_UNAVAILABLE", "Node unavailable");
	if (!node.outputs || !Object.hasOwn(node.outputs, name))
		throw new CodedError("RESOURCE_UNAVAILABLE", "Output unavailable");
	if (!node.proposalId) return null;
	const output = unwrap(await client.getOutput({ dagId: id, proposalId: node.proposalId, name }));
	const base = {
		nodeId,
		name,
		proposalId: node.proposalId,
		disposition: output.disposition,
		kind: output.value.kind,
		sizeBytes: output.value.file.sizeBytes,
	};
	if (output.value.kind === "artifact") {
		const { file } = output.value;
		const preview = await previewArtifact(
			{
				localPath: file.localPath,
				sizeBytes: file.sizeBytes,
				sha256: file.sha256,
				label: output.value.preview,
			},
			maxBytes,
			imageMaxBytes,
		);
		return {
			...base,
			...(preview.text === undefined ? {} : { text: preview.text }),
			truncated: preview.truncated,
			artifact: preview.artifact,
		};
	}
	try {
		const head = await readHead(output.value.file.localPath, maxBytes);
		return {
			...base,
			text: new TextDecoder("utf-8", { fatal: false }).decode(head.bytes),
			truncated: head.truncated,
		};
	} catch {
		throw new CodedError("RESOURCE_UNAVAILABLE", "Output unavailable");
	}
}

function startWorkspaceId(params: unknown): string {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid DAG start request");
	const { workspaceId } = params as { workspaceId?: unknown };
	if (!isHostResourceId(workspaceId)) throw new Error("Invalid workspaceId");
	return workspaceId;
}

/**
 * `dag.start`: a person starts a factory run (see `startFactory`). The DAG is created by the human
 * binding, paused, and announced like any other change.
 */
export async function startWorkspaceFactory(params: unknown): Promise<DagStartResult> {
	const workspaceId = startWorkspaceId(params);
	const result = await startFactory(await commandClient(workspaceId), params);
	publishDagChangedNow({ workspaceId, dagId: result.dagId });
	return result;
}

/** `dag.startFromPlan`: the factory DAG from a planning DAG whose plan a person approved. */
export async function startWorkspaceFactoryFromPlan(params: unknown): Promise<DagStartResult> {
	const workspaceId = startWorkspaceId(params);
	const result = await startFactoryFromPlan(await commandClient(workspaceId), params);
	publishDagChangedNow({ workspaceId, dagId: result.dagId });
	return result;
}

/**
 * `dag.replan`: a person sends a rejected factory release back to the planner. Creates a new, paused
 * planning DAG (see `replanFactory`); the caller is the human binding, never a wire field.
 */
export async function replanWorkspaceFactory(params: unknown): Promise<DagStartResult> {
	const workspaceId = startWorkspaceId(params);
	const result = await replanFactory(await commandClient(workspaceId), params);
	publishDagChangedNow({ workspaceId, dagId: result.dagId });
	return result;
}
