import {
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { A2AClient, type A2AEndpoint, assertHttpUrl, settled } from "./client.ts";
import { type ConfiguredAgent, loadConfiguredAgents } from "./config.ts";
import {
	type AgentCard,
	isTask,
	type Message,
	partsText,
	type Task,
	textMessage,
} from "./protocol.ts";

export interface A2AExtensionOptions {
	fetch?: typeof fetch;
	agentDir?: string;
	/** Extra agents an embedder knows about (e.g. its own A2A endpoint); config files still win. */
	agents?: () => readonly ConfiguredAgent[];
}

const MAX_TEXT = 50_000;

function bounded(text: string): string {
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…[truncated]` : text;
}

export function describeCard(card: AgentCard): string {
	const skills = card.skills
		.map((skill) => `  - ${skill.name} (${skill.id}): ${skill.description}`)
		.join("\n");
	return [`${card.name} v${card.version} — ${card.description}`, `  endpoint: ${card.url}`, skills]
		.filter(Boolean)
		.join("\n");
}

export function describeResult(result: Task | Message): string {
	if (!isTask(result)) return bounded(`Reply: ${partsText(result.parts)}`);
	const lines = [`Task ${result.id} (context ${result.contextId}) — ${result.status.state}`];
	if (result.status.message) lines.push(partsText(result.status.message.parts));
	for (const artifact of result.artifacts ?? [])
		lines.push(
			`\n## Artifact ${artifact.name ?? artifact.artifactId}\n${partsText(artifact.parts)}`,
		);
	if (!settled(result))
		lines.push(
			"\nThe task is still running: check on it later with a2a_task instead of waiting idly.",
		);
	if (result.status.state === "input-required")
		lines.push(
			"\nThe agent needs input: reply with a2a_send using the same task_id and context_id.",
		);
	return bounded(lines.join("\n"));
}

export function createA2AExtension(options: A2AExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI): void => {
		const clients = new Map<string, A2AClient>();

		function configured(ctx: { cwd: string; isProjectTrusted(): boolean }): ConfiguredAgent[] {
			const fromFiles = loadConfiguredAgents({
				agentDir: options.agentDir ?? getAgentDir(),
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
			});
			const names = new Set(fromFiles.map((agent) => agent.name));
			return [
				...fromFiles,
				...(options.agents?.() ?? []).filter((agent) => !names.has(agent.name)),
			];
		}

		function resolve(
			agent: string,
			ctx: { cwd: string; isProjectTrusted(): boolean },
		): A2AEndpoint {
			const named = configured(ctx).find((candidate) => candidate.name === agent);
			if (named) return named;
			if (/^https?:\/\//i.test(agent)) {
				assertHttpUrl(agent);
				return { url: agent };
			}
			const known = configured(ctx).map((candidate) => candidate.name);
			throw new Error(
				`Unknown A2A agent "${agent}". ${known.length ? `Configured: ${known.join(", ")}.` : "No agents are configured (add them to a2a.json)."} You may also pass the agent's URL.`,
			);
		}

		function clientFor(endpoint: A2AEndpoint): A2AClient {
			const key = `${endpoint.url}\n${JSON.stringify(endpoint.headers ?? {})}`;
			let client = clients.get(key);
			if (!client) {
				client = new A2AClient(endpoint, options.fetch ? { fetch: options.fetch } : {});
				clients.set(key, client);
			}
			return client;
		}

		pi.registerTool({
			name: "a2a_agents",
			label: "A2A agents",
			description:
				"List the remote Agent2Agent (A2A) agents you can delegate to, with their skills. Pass `url` to discover an agent that is not configured by reading its agent card.",
			promptSnippet: "Discover remote A2A agents and their skills before delegating work to them.",
			parameters: Type.Object({
				url: Type.Optional(Type.String({ description: "Base URL or agent-card URL to discover" })),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const targets: Array<{ name: string; endpoint: A2AEndpoint }> = params.url
					? [{ name: params.url, endpoint: { url: params.url } }]
					: configured(ctx).map((agent) => ({ name: agent.name, endpoint: agent }));
				if (targets.length === 0)
					return {
						content: [
							{ type: "text", text: "No A2A agents are configured. Pass a url to discover one." },
						],
						details: { agents: [] },
					};
				const results = await Promise.all(
					targets.map(async ({ name, endpoint }) => {
						try {
							const card = await clientFor(endpoint).getCard(signal);
							return { name, card };
						} catch (error) {
							return { name, error: error instanceof Error ? error.message : String(error) };
						}
					}),
				);
				const text = results
					.map((result) =>
						"card" in result && result.card
							? `### ${result.name}\n${describeCard(result.card)}`
							: `### ${result.name}\n  unreachable: ${result.error}`,
					)
					.join("\n\n");
				return { content: [{ type: "text", text }], details: { agents: results } };
			},
		});

		pi.registerTool({
			name: "a2a_send",
			label: "A2A send",
			description:
				"Send a task or message to a remote A2A agent and (by default) wait for its result. Give it a self-contained task: the remote agent does not see this conversation. To continue an existing task (e.g. one that needs input) pass its task_id and context_id.",
			promptSnippet:
				"Delegate a self-contained subtask to a remote A2A agent and collect its result and artifacts.",
			parameters: Type.Object({
				agent: Type.String({ description: "Configured agent name, or the agent's URL" }),
				message: Type.String({ description: "The full, self-contained task or reply" }),
				context_id: Type.Optional(Type.String()),
				task_id: Type.Optional(Type.String()),
				wait: Type.Optional(
					Type.Boolean({ description: "Wait for a terminal state (default true)" }),
				),
				timeout_seconds: Type.Optional(Type.Number({ minimum: 5, maximum: 3600 })),
			}),
			async execute(_id, params, signal, onUpdate, ctx) {
				const client = clientFor(resolve(params.agent, ctx));
				const message = textMessage("user", params.message, {
					...(params.context_id ? { contextId: params.context_id } : {}),
					...(params.task_id ? { taskId: params.task_id } : {}),
				});
				let result = await client.sendMessage(
					{
						message,
						configuration: {
							blocking: false,
							acceptedOutputModes: ["text/plain", "application/json", "text/x-diff"],
						},
					},
					signal,
				);
				if (isTask(result) && params.wait !== false && !settled(result)) {
					result = await client.waitForTask(result, {
						...(signal ? { signal } : {}),
						deadlineMs: (params.timeout_seconds ?? 600) * 1000,
						onUpdate: (task) =>
							onUpdate?.({
								content: [{ type: "text", text: describeResult(task) }],
								details: { result: task },
							}),
					});
				}
				if (
					isTask(result) &&
					(result.status.state === "failed" || result.status.state === "rejected")
				)
					throw new Error(describeResult(result));
				return {
					content: [{ type: "text", text: describeResult(result) }],
					details: { agent: params.agent, result },
				};
			},
		});

		pi.registerTool({
			name: "a2a_task",
			label: "A2A task",
			description:
				"Check on (get), wait for, or cancel a task previously sent to a remote A2A agent.",
			parameters: Type.Object({
				agent: Type.String({ description: "Configured agent name, or the agent's URL" }),
				task_id: Type.String(),
				action: Type.Optional(
					Type.Union([Type.Literal("get"), Type.Literal("wait"), Type.Literal("cancel")], {
						description: "Default get",
					}),
				),
			}),
			async execute(_id, params, signal, _onUpdate, ctx) {
				const client = clientFor(resolve(params.agent, ctx));
				let task =
					params.action === "cancel"
						? await client.cancelTask(params.task_id, signal)
						: await client.getTask(params.task_id, signal);
				if (params.action === "wait")
					task = await client.waitForTask(task, signal ? { signal } : {});
				return {
					content: [{ type: "text", text: describeResult(task) }],
					details: { agent: params.agent, result: task },
				};
			},
		});
	};
}
