import { homedir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	type A2AEndpoint,
	assertHttpUrl,
	createA2AExtension,
	loadConfiguredAgents,
} from "@thinkrail/pi-a2a";
import { createDelegationService, type DelegationService } from "pi-delegation";
import { discoverAgentDefinitions } from "pi-subagents";
import { Type } from "typebox";
import { formatPosts, type Member } from "./board.ts";
import { detectGates } from "./gates.ts";
import { repoRoot } from "./git.ts";
import { swarmMemberExtension } from "./memberExtension.ts";
import { coordinatorPrompt } from "./prompts.ts";
import { type Isolation, Swarm, type SwarmSnapshot } from "./swarm.ts";

export const SWARM_BOARD_MESSAGE = "swarm-board";
export const SWARM_TOOLS = [
	"swarm_start",
	"swarm_add",
	"swarm_post",
	"swarm_board",
	"swarm_status",
	"swarm_diff",
	"swarm_land",
	"swarm_remove",
	"swarm_finish",
] as const;

export interface SwarmOptions {
	/** The embedder's delegation service; without one, a session-scoped service is built. */
	service?: DelegationService;
	worktreeRoot?: string;
	isEnabled?: () => boolean;
	canDeliver?: () => boolean;
	onChange?: (snapshot: SwarmSnapshot) => void;
	monitorDelayMs?: number;
	fetch?: typeof fetch;
}

export interface SwarmOwner {
	readonly extension: ExtensionFactory;
	current(): Swarm | undefined;
	/** Delivers held @coordinator posts when the parent is idle and delivery is allowed. */
	flush(): void;
	dispose(): Promise<void>;
}

function memberLine(member: Member): string {
	const where = member.worktree ? ` · ${member.worktree.branch}` : "";
	const extra = member.error
		? ` · error: ${member.error}`
		: member.activity
			? ` · ${member.activity}`
			: "";
	return `@${member.name} [${member.kind}] ${member.status}/${member.phase}${member.model ? ` · ${member.model}` : ""}${where}${member.landed ? " · landed" : ""}${extra}`;
}

export function describeSwarm(snapshot: SwarmSnapshot): string {
	const members = snapshot.members.map(memberLine).join("\n") || "(no members)";
	return `Swarm "${snapshot.title}" — ${snapshot.status}, ${snapshot.posts.length} posts\nGates: ${
		snapshot.config.gates.join(" && ") || "none"
	} · review: ${snapshot.config.review ? "on" : "off"} · isolation: ${snapshot.config.isolation}\n${members}`;
}

const BriefFields = {
	task: Type.String({ description: "Self-contained task: the member starts with a clean context" }),
	owns: Type.Optional(
		Type.Array(Type.String(), { description: "Paths/globs this member may change" }),
	),
	avoid: Type.Optional(Type.Array(Type.String(), { description: "Paths/globs it must not touch" })),
	done: Type.Optional(Type.String({ description: "What done looks like" })),
};

export function createSwarm(options: SwarmOptions = {}): SwarmOwner {
	let swarm: Swarm | undefined;
	let fallback: DelegationService | undefined;
	let parentSessionId: string | undefined;
	let api: ExtensionAPI | undefined;
	let latest: ExtensionContext | undefined;
	let held = false;
	let closed = false;

	function service(ctx: ExtensionContext): DelegationService {
		latest = ctx;
		if (options.service) return options.service;
		fallback ??= createDelegationService({
			resolveParent: (id) =>
				latest && id === latest.sessionManager.getSessionId() ? latest : undefined,
			childExtensionFactories: [swarmMemberExtension, createA2AExtension()],
		});
		return fallback;
	}

	function idle(): boolean {
		try {
			return latest?.isIdle() ?? false;
		} catch {
			return false;
		}
	}

	function flush(): void {
		if (!swarm || !api || closed || !held) return;
		if (!idle() || (options.canDeliver && !options.canDeliver())) return;
		const posts = swarm.takeCoordinatorPosts();
		held = false;
		if (posts.length === 0) return;
		api.sendMessage(
			{
				customType: SWARM_BOARD_MESSAGE,
				content: `Swarm board — new posts for you:\n\n${formatPosts(posts)}`,
				display: true,
				details: { swarmId: swarm.id, posts },
			},
			{ triggerTurn: true },
		);
	}

	function resolveA2A(ctx: ExtensionContext, agent: string): A2AEndpoint {
		const configured = loadConfiguredAgents({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
		}).find((candidate) => candidate.name === agent);
		if (configured) return configured;
		assertHttpUrl(agent);
		return { url: agent };
	}

	function requireSwarm(): Swarm {
		if (!swarm) throw new Error("No swarm in this conversation. Start one with swarm_start.");
		return swarm;
	}

	const extension: ExtensionFactory = (pi) => {
		api = pi;
		pi.on("session_start", (_event, ctx) => {
			const id = ctx.sessionManager.getSessionId();
			if (parentSessionId !== undefined && parentSessionId !== id)
				throw new Error("This swarm owner belongs to another session");
			parentSessionId = id;
			latest = ctx;
			if (options.isEnabled && !options.isEnabled())
				pi.setActiveTools(
					pi.getActiveTools().filter((tool) => !(SWARM_TOOLS as readonly string[]).includes(tool)),
				);
		});
		pi.on("agent_settled", () => {
			setTimeout(flush, 0);
		});
		pi.on("session_shutdown", async (event) => {
			if (event.reason === "reload") return;
			closed = true;
			await swarm?.dispose();
		});

		pi.registerCommand("swarm", {
			description:
				"Run a team of named agents that split the task and coordinate on a shared board",
			handler: async (args) => {
				const task = args.trim();
				if (!task) throw new Error("Usage: /swarm <task and how to verify it>");
				pi.sendUserMessage(coordinatorPrompt(task));
			},
		});

		pi.registerTool({
			name: "swarm_start",
			label: "Start swarm",
			description:
				"Create this conversation's swarm (you become its @coordinator). Quality gates default to the project's typecheck/lint/test scripts; workers get isolated git worktrees by default.",
			promptSnippet:
				"Coordinate a team of named agents on a shared board for broad tasks that split cleanly (/swarm).",
			parameters: Type.Object({
				title: Type.String(),
				gates: Type.Optional(
					Type.Array(Type.String(), {
						description: "Commands every worker must pass, run in its working copy",
					}),
				),
				review: Type.Optional(
					Type.Boolean({ description: "Read-only reviewer on each worker's diff (default true)" }),
				),
				isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("shared")])),
				setup: Type.Optional(
					Type.Array(Type.String(), {
						description: "Commands run in each new worktree, e.g. an install",
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (swarm?.status === "running")
					throw new Error(`Swarm "${swarm.title}" is still running; swarm_finish it first.`);
				const svc = service(ctx);
				const repo = await repoRoot(ctx.cwd);
				const isolation: Isolation = params.isolation ?? (repo ? "worktree" : "shared");
				await swarm?.dispose();
				const sessionId = ctx.sessionManager.getSessionId();
				swarm = new Swarm(
					{
						title: params.title,
						gates: params.gates ?? detectGates(repo ?? ctx.cwd),
						review: params.review ?? true,
						isolation,
						setup: params.setup ?? [],
						maxFixRounds: 3,
					},
					{
						service: svc,
						parentSessionId: sessionId,
						cwd: ctx.cwd,
						...(repo ? { repo } : {}),
						worktreeRoot: options.worktreeRoot ?? join(homedir(), ".pi", "swarm-worktrees"),
						definitions: () =>
							discoverAgentDefinitions({
								cwd: ctx.cwd,
								agentDir: getAgentDir(),
								includeProject: ctx.isProjectTrusted(),
							}),
						availableModels: () => ctx.modelRegistry.getAvailable(),
						resolveA2A: (agent) => resolveA2A(ctx, agent),
						notifyCoordinator: () => {
							held = true;
							flush();
						},
						isCoordinatorIdle: idle,
						onChange: (snapshot) => options.onChange?.(snapshot),
						...(options.monitorDelayMs !== undefined
							? { monitorDelayMs: options.monitorDelayMs }
							: {}),
						...(options.fetch ? { fetch: options.fetch } : {}),
					},
				);
				const snapshot = swarm.snapshot();
				return {
					content: [
						{ type: "text", text: `${describeSwarm(snapshot)}\n\nAdd members with swarm_add.` },
					],
					details: snapshot,
				};
			},
		});

		pi.registerTool({
			name: "swarm_add",
			label: "Add swarm member",
			description:
				"Add a named member that starts on its brief at once with a clean context. kind: worker (edits, isolated worktree, gated + reviewed), verifier (runs tests on the landed result), scout (read-only investigation), reviewer. `definition` uses a named agent definition instead; `a2a_agent` makes a remote A2A agent a member. `count` adds a numbered pool name-1..name-N addressable as @name.",
			parameters: Type.Object({
				name: Type.String({ description: "Lowercase handle without @, e.g. parser" }),
				...BriefFields,
				kind: Type.Optional(
					Type.Union([
						Type.Literal("worker"),
						Type.Literal("verifier"),
						Type.Literal("scout"),
						Type.Literal("reviewer"),
					]),
				),
				definition: Type.Optional(Type.String()),
				model: Type.Optional(
					Type.String({ description: "provider/id[:thinking]; default: your model" }),
				),
				isolation: Type.Optional(Type.Union([Type.Literal("worktree"), Type.Literal("shared")])),
				a2a_agent: Type.Optional(Type.String({ description: "Configured A2A agent name or URL" })),
				count: Type.Optional(Type.Number({ minimum: 2, maximum: 8 })),
			}),
			async execute(_id, params, _signal, _onUpdate) {
				const active = requireSwarm();
				const names = params.count
					? Array.from({ length: params.count }, (_, i) => `${params.name}-${i + 1}`)
					: [params.name];
				const added: Member[] = [];
				for (const name of names)
					added.push(
						await active.addMember({
							name,
							...(params.count ? { group: params.name } : {}),
							brief: {
								task: params.task,
								owns: params.owns ?? [],
								avoid: params.avoid ?? [],
								...(params.done ? { done: params.done } : {}),
							},
							...(params.kind ? { kind: params.kind } : {}),
							...(params.definition ? { definition: params.definition } : {}),
							...(params.model ? { model: params.model } : {}),
							...(params.isolation ? { isolation: params.isolation } : {}),
							...(params.a2a_agent ? { a2aAgent: params.a2a_agent } : {}),
						}),
					);
				return {
					content: [
						{
							type: "text",
							text: `Added and started:\n${added.map(memberLine).join("\n")}\nEnd your turn to wait; reports wake you.`,
						},
					],
					details: active.snapshot(),
				};
			},
		});

		pi.registerTool({
			name: "swarm_post",
			label: "Swarm post",
			description:
				"Post to the board as @coordinator. Mention @name, @group or @all to wake members.",
			parameters: Type.Object({
				text: Type.String(),
				to: Type.Optional(Type.Array(Type.String())),
			}),
			async execute(_id, params) {
				const active = requireSwarm();
				const post = active.post("coordinator", params.text, "message", params.to ?? []);
				if (post.to.length === 0)
					throw new Error("The post mentions no live member; nobody would read it.");
				return {
					content: [
						{
							type: "text",
							text: `Posted #${post.seq} to ${post.to.map((n) => `@${n}`).join(" ")}.`,
						},
					],
					details: active.snapshot(),
				};
			},
		});

		pi.registerTool({
			name: "swarm_board",
			label: "Swarm board",
			description: "Read the board (all posts, or from/to one member).",
			parameters: Type.Object({
				since: Type.Optional(Type.Number()),
				member: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
			}),
			async execute(_id, params) {
				const active = requireSwarm();
				return {
					content: [{ type: "text", text: formatPosts(active.board.read(params)) }],
					details: active.snapshot(),
				};
			},
		});

		pi.registerTool({
			name: "swarm_status",
			label: "Swarm status",
			description: "Members, their states, phases, models, worktrees and gate/review results.",
			parameters: Type.Object({}),
			async execute() {
				const snapshot = requireSwarm().snapshot();
				return { content: [{ type: "text", text: describeSwarm(snapshot) }], details: snapshot };
			},
		});

		pi.registerTool({
			name: "swarm_diff",
			label: "Swarm diff",
			description: "Show a worktree member's uncommitted diff against its base.",
			parameters: Type.Object({ name: Type.String() }),
			async execute(_id, params) {
				const { patch, stat } = await requireSwarm().diff(params.name);
				const body = patch.length > 50_000 ? `${patch.slice(0, 50_000)}\n…[truncated]` : patch;
				return {
					content: [
						{
							type: "text",
							text: patch ? `${stat}\n\n\`\`\`diff\n${body}\n\`\`\`` : "No changes.",
						},
					],
					details: { name: params.name, stat, patch: body },
				};
			},
		});

		pi.registerTool({
			name: "swarm_land",
			label: "Land swarm member",
			description:
				"Apply a worktree member's changes to your working tree (uncommitted). Land a member after it passes its gates and review.",
			parameters: Type.Object({ name: Type.String() }),
			async execute(_id, params) {
				const active = requireSwarm();
				return {
					content: [{ type: "text", text: await active.land(params.name) }],
					details: active.snapshot(),
				};
			},
		});

		pi.registerTool({
			name: "swarm_remove",
			label: "Remove swarm member",
			description:
				"Permanently remove a member and its worktree. Refuses unlanded changes unless force is set.",
			parameters: Type.Object({ name: Type.String(), force: Type.Optional(Type.Boolean()) }),
			async execute(_id, params) {
				const active = requireSwarm();
				return {
					content: [
						{ type: "text", text: await active.remove(params.name, params.force ?? false) },
					],
					details: active.snapshot(),
				};
			},
		});

		pi.registerTool({
			name: "swarm_finish",
			label: "Finish swarm",
			description:
				"Mark the swarm finished (stops the monitor). Waiting members cost nothing; remove them when you no longer need their worktrees.",
			parameters: Type.Object({ summary: Type.String() }),
			async execute(_id, params) {
				const active = requireSwarm();
				active.finish(params.summary);
				return {
					content: [{ type: "text", text: describeSwarm(active.snapshot()) }],
					details: active.snapshot(),
				};
			},
		});
	};

	return {
		extension,
		current: () => swarm,
		flush,
		dispose: async () => {
			closed = true;
			await swarm?.dispose();
			await fallback?.disposeChildrenOf(parentSessionId ?? "");
		},
	};
}
