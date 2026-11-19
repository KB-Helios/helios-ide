import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiEvent, Workspace } from "@thinkrail/contracts";
import {
	A2A_ERRORS,
	A2A_PROTOCOL_VERSION,
	A2AError,
	type AgentCard,
	type Artifact,
	createA2AHandler,
	type MessageSendParams,
	partsText,
	type Task,
	TERMINAL_STATES,
	textMessage,
} from "@thinkrail/pi-a2a";
import { BUILTIN_AGENTS } from "pi-subagents";
import {
	commitWorktree,
	describeGates,
	detectGates,
	runCommand as run,
	runGates,
	worktreeDiff,
} from "pi-swarm";
import { abortSession, runReviewSubagent, sendHostMessageToSession } from "../agent";
import { logger } from "../log";
import { dataDir } from "../persistence";
import { listProjects } from "../projects";
import { createWorkspace, isChatsContainer } from "../workspaces";
import { ackSend } from "./ackSend";
import { startChatSession } from "./chatSession";

const log = logger("a2a");

export const A2A_ROUTE = "/a2a";
export const A2A_CARD_ROUTES = ["/.well-known/agent-card.json", "/.well-known/agent.json"] as const;
export const A2A_TASK_CUSTOM_TYPE = "a2a-task";
const MAX_FIX_ROUNDS = 2;
const MAX_PATCH = 1_000_000;

interface InboundTask {
	task: Task;
	workspace: Workspace;
	sessionId: string;
	base: string;
	rounds: number;
	lastReply?: string;
	finalizing: boolean;
}

const tasks = new Map<string, InboundTask>();
const bySession = new Map<string, string>();

/** Inbound A2A is off unless a token is configured: env `THINKRAIL_A2A_TOKEN` or `<dataDir>/a2a/token`. */
export function a2aToken(): string | undefined {
	const fromEnv = process.env.THINKRAIL_A2A_TOKEN?.trim();
	if (fromEnv) return fromEnv;
	try {
		return readFileSync(join(dataDir(), "a2a", "token"), "utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}

function authorize(request: Request): void {
	const token = a2aToken();
	const header = request.headers.get("authorization") ?? "";
	const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
	const ok =
		token !== undefined &&
		presented.length === token.length &&
		timingSafeEqual(Buffer.from(presented), Buffer.from(token));
	if (!ok) throw new A2AError(-32000, "Unauthorized: send the host's A2A bearer token");
}

function card(origin: string): AgentCard {
	return {
		protocolVersion: A2A_PROTOCOL_VERSION,
		name: "ThinkRail",
		description:
			"A pi coding agent in a ThinkRail IDE. Each task runs in a fresh git worktree workspace, must pass the project's typecheck/lint/test gates and a read-only review, and returns its branch, commit and diff as artifacts.",
		url: `${origin}${A2A_ROUTE}`,
		version: "1",
		preferredTransport: "JSONRPC",
		capabilities: { streaming: false, pushNotifications: false },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain", "text/x-diff", "application/json"],
		skills: [
			{
				id: "coding-task",
				name: "Coding task",
				description:
					"Implement, fix or refactor code in an open project. Pass metadata.projectId when more than one project is open. Continue a task by sending a message with its taskId.",
				tags: ["coding", "git", "worktree"],
				examples: ["Add input validation to src/routes/users.ts and cover it with tests"],
			},
		],
		securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
		security: [{ bearer: [] }],
	};
}

function now(): string {
	return new Date().toISOString();
}

function setState(entry: InboundTask, state: Task["status"]["state"], text?: string): void {
	entry.task.status = {
		state,
		timestamp: now(),
		...(text
			? {
					message: textMessage("agent", text, {
						taskId: entry.task.id,
						contextId: entry.task.contextId,
					}),
				}
			: {}),
	};
}

function pickProject(metadata: Record<string, unknown> | undefined) {
	const projects = listProjects().filter((project) => !isChatsContainer(project));
	const wanted = typeof metadata?.projectId === "string" ? metadata.projectId : undefined;
	const project = wanted
		? projects.find((p) => p.id === wanted)
		: projects.length === 1
			? projects[0]
			: undefined;
	if (!project)
		throw new A2AError(
			A2A_ERRORS.invalidParams,
			wanted
				? `Project ${wanted} is not open`
				: "Pass metadata.projectId: more than one project is open",
			{ projects: projects.map((p) => ({ id: p.id, name: p.name })) },
		);
	return project;
}

function taskPrompt(text: string, gates: readonly string[]): string {
	return `A remote agent assigned this coding task over A2A:

${text}

You are in a fresh git worktree workspace made for this task. Follow AGENTS.md and the SPEC.md of the
modules you change, and keep changes focused on the task. Do not commit: ThinkRail commits the result.
${gates.length ? `Before you finish, make these pass: ${gates.map((g) => `\`${g}\``).join(", ")}.` : ""}
When you are done, end with a short summary of what changed and how you verified it. ThinkRail then runs
the gates and a read-only review; problems come back to you in this chat.`;
}

async function sendToTask(entry: InboundTask, text: string): Promise<void> {
	await ackSend(
		sendHostMessageToSession(entry.sessionId, A2A_TASK_CUSTOM_TYPE, text, {
			taskId: entry.task.id,
		}),
	);
}

async function startTask(params: MessageSendParams): Promise<Task> {
	const metadata = { ...params.metadata, ...params.message.metadata };
	const text = partsText(params.message.parts).trim();
	if (!text) throw new A2AError(A2A_ERRORS.invalidParams, "The message has no text");
	const project = pickProject(metadata);
	const workspace = await createWorkspace(project.id);
	const sessionId = (await startChatSession(workspace, {})).sessionId;
	const base = (
		await run("git", ["rev-parse", "HEAD"], { cwd: workspace.worktreePath })
	).stdout.trim();
	const id = randomUUID();
	const entry: InboundTask = {
		task: {
			kind: "task",
			id,
			contextId: params.message.contextId ?? randomUUID(),
			status: { state: "submitted", timestamp: now() },
			history: [params.message],
			metadata: {
				projectId: project.id,
				workspaceId: workspace.id,
				sessionId,
				branch: workspace.branch,
			},
		},
		workspace,
		sessionId,
		base,
		rounds: 0,
		finalizing: false,
	};
	tasks.set(id, entry);
	bySession.set(sessionId, id);
	await sendToTask(entry, taskPrompt(text, detectGates(workspace.worktreePath)));
	setState(
		entry,
		"working",
		`Working in workspace "${workspace.name}" on branch ${workspace.branch}.`,
	);
	return entry.task;
}

async function continueTask(params: MessageSendParams): Promise<Task> {
	const entry = tasks.get(params.message.taskId ?? "");
	if (!entry) throw new A2AError(A2A_ERRORS.taskNotFound, "Unknown task");
	if (TERMINAL_STATES.has(entry.task.status.state) && entry.task.status.state !== "completed")
		throw new A2AError(A2A_ERRORS.taskNotCancelable, `Task is ${entry.task.status.state}`);
	entry.task.history?.push(params.message);
	entry.rounds = 0;
	await sendToTask(entry, `Follow-up from the remote agent:\n\n${partsText(params.message.parts)}`);
	setState(entry, "working");
	return entry.task;
}

function reviewPrompt(entry: InboundTask, stat: string, patch: string): string {
	return `Review this change, made for an A2A coding task.

Task:
${partsText(entry.task.history?.[0]?.parts)}

Diff stat:
${stat}

\`\`\`diff
${patch.slice(0, 80_000)}
\`\`\`

Report only material problems this diff introduces. End with exactly one line:
VERDICT: APPROVE  or  VERDICT: CHANGES_REQUESTED`;
}

async function finalize(entry: InboundTask): Promise<void> {
	if (entry.finalizing || entry.task.status.state !== "working") return;
	entry.finalizing = true;
	const cwd = entry.workspace.worktreePath;
	try {
		setState(entry, "working", "Running quality gates");
		const gates = await runGates(detectGates(cwd), cwd);
		const failedGates = gates.some((g) => !g.ok);
		let review: { verdict: "approve" | "changes"; text: string } | undefined;
		if (!failedGates) {
			setState(entry, "working", "Under read-only review");
			const { patch, stat } = await worktreeDiff(cwd);
			const reviewer = BUILTIN_AGENTS.find((agent) => agent.name === "reviewer");
			if (patch.trim() && reviewer) {
				const result = await runReviewSubagent(
					entry.workspace.id,
					entry.sessionId,
					reviewPrompt(entry, stat, patch),
					{ systemPrompt: reviewer.systemPrompt, tools: ["read", "grep", "find", "ls"] },
				);
				const text = result.finalText ?? "";
				review = {
					verdict: /VERDICT:\s*CHANGES_REQUESTED/i.test(text) ? "changes" : "approve",
					text,
				};
			}
		}
		const problems = [
			...(failedGates ? [`Quality gates failed:\n${describeGates(gates)}`] : []),
			...(review?.verdict === "changes" ? [`The reviewer requested changes:\n${review.text}`] : []),
		];
		if (problems.length && entry.rounds < MAX_FIX_ROUNDS) {
			entry.rounds += 1;
			setState(entry, "working", `Fix round ${entry.rounds}`);
			entry.finalizing = false;
			await sendToTask(
				entry,
				`${problems.join("\n\n")}\n\nFix these, then end with a short summary again.`,
			);
			return;
		}
		const commit = await commitWorktree(cwd, `A2A task ${entry.task.id}`);
		const diff = commit
			? (await run("git", ["diff", "--binary", `${entry.base}..HEAD`], { cwd })).stdout
			: "";
		const artifacts: Artifact[] = [
			{
				artifactId: "summary",
				name: "Summary",
				parts: [{ kind: "text", text: entry.lastReply ?? "(no summary)" }],
			},
			{
				artifactId: "branch",
				name: "Branch",
				parts: [
					{
						kind: "data",
						data: {
							branch: entry.workspace.branch,
							commit: commit ?? null,
							base: entry.base,
							workspaceId: entry.workspace.id,
							sessionId: entry.sessionId,
							worktreePath: cwd,
							gates: gates.map(({ command, ok }) => ({ command, ok })),
							review: review?.verdict ?? "skipped",
						},
					},
				],
			},
		];
		if (diff)
			artifacts.push({
				artifactId: "diff",
				name: "Diff",
				parts: [
					{ kind: "text", text: diff.slice(0, MAX_PATCH), metadata: { mimeType: "text/x-diff" } },
				],
			});
		entry.task.artifacts = artifacts;
		setState(
			entry,
			problems.length ? "failed" : "completed",
			problems.length
				? `Finished with unresolved problems after ${MAX_FIX_ROUNDS} fix rounds:\n${problems.join("\n\n")}`
				: commit
					? `Committed ${commit.slice(0, 12)} on ${entry.workspace.branch}.`
					: "Finished with no changes.",
		);
	} catch (error) {
		log.warn(`a2a task ${entry.task.id} could not finish`);
		setState(entry, "failed", error instanceof Error ? error.message : "Internal error");
	} finally {
		entry.finalizing = false;
	}
}

function assistantText(event: PiEvent): string | undefined {
	if (event.type !== "message_end") return undefined;
	const message = event.message as { role?: string; content?: unknown };
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text")
		.map((part) => part.text)
		.join("")
		.trim();
	return text || undefined;
}

/** Fed every session event: records the agent's reply and finalizes the task when its run settles. */
export function observeA2ATask(sessionId: string, event: PiEvent): void {
	const id = bySession.get(sessionId);
	const entry = id ? tasks.get(id) : undefined;
	if (!entry) return;
	const text = assistantText(event);
	if (text) entry.lastReply = text;
	if (event.type === "agent_settled") void finalize(entry);
}

const handler = createA2AHandler({
	card: () => card(""),
	authorize,
	sendMessage: (params) => (params.message.taskId ? continueTask(params) : startTask(params)),
	getTask: async ({ id }) => {
		const entry = tasks.get(id);
		if (!entry) throw new A2AError(A2A_ERRORS.taskNotFound, "Unknown task");
		return entry.task;
	},
	cancelTask: async ({ id }) => {
		const entry = tasks.get(id);
		if (!entry) throw new A2AError(A2A_ERRORS.taskNotFound, "Unknown task");
		if (TERMINAL_STATES.has(entry.task.status.state))
			throw new A2AError(A2A_ERRORS.taskNotCancelable, `Task is ${entry.task.status.state}`);
		await abortSession(entry.sessionId).catch(() => {});
		setState(entry, "canceled", "Canceled by the remote agent.");
		return entry.task;
	},
});

export function isA2ARoute(pathname: string): boolean {
	return pathname === A2A_ROUTE || (A2A_CARD_ROUTES as readonly string[]).includes(pathname);
}

/** Serves the agent card and JSON-RPC endpoint; 404 while no token is configured. */
export async function serveA2A(request: Request): Promise<Response> {
	if (!a2aToken()) return new Response("not found", { status: 404 });
	const url = new URL(request.url);
	if (request.method === "GET" && url.pathname !== A2A_ROUTE)
		return Response.json(card(url.origin));
	return handler(request);
}

export function resetA2AForTests(): void {
	tasks.clear();
	bySession.clear();
}
