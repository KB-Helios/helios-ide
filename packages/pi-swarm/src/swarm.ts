import {
	A2AClient,
	type A2AEndpoint,
	describeResult,
	isTask,
	type Message,
	settled,
	type Task,
	textMessage,
} from "@thinkrail/pi-a2a";
import type { ChildHandle, DelegationService, RunOutcome, SessionOptions } from "pi-delegation";
import { type AgentDefinition, toSpawnMapping } from "pi-subagents";
import {
	Board,
	COORDINATOR,
	formatPosts,
	type GraphEdge,
	type Member,
	type MemberBrief,
	type MemberKind,
	MONITOR,
	type Post,
	type PostKind,
} from "./board.ts";
import { describeGates, runGates } from "./gates.ts";
import {
	applyPatch,
	changedFiles,
	createWorktree,
	ownershipViolations,
	removeWorktree,
	run,
	worktreeDiff,
} from "./git.ts";
import { MEMBER_TOOLS, memberBridge, reviewTask, reviewVerdict, wakePrompt } from "./prompts.ts";
import { forgetMember, rememberMember } from "./registry.ts";

export type Isolation = "worktree" | "shared";

export interface SwarmConfig {
	title: string;
	gates: string[];
	review: boolean;
	isolation: Isolation;
	setup: string[];
	maxFixRounds: number;
}

export interface SwarmSnapshot {
	id: string;
	parentSessionId: string;
	title: string;
	status: "running" | "finished";
	summary?: string;
	createdAt: string;
	config: SwarmConfig;
	members: Member[];
	posts: Post[];
	graph: GraphEdge[];
}

export interface SwarmDeps {
	service: DelegationService;
	parentSessionId: string;
	cwd: string;
	/** Git repository root of `cwd`; worktree isolation needs one. */
	repo?: string;
	worktreeRoot: string;
	definitions: () => readonly AgentDefinition[];
	availableModels: () => readonly { provider: string; id: string }[];
	resolveA2A: (agent: string) => A2AEndpoint;
	/** Called when posts for @coordinator are waiting; the owner decides when to deliver them. */
	notifyCoordinator: () => void;
	isCoordinatorIdle: () => boolean;
	onChange: (snapshot: SwarmSnapshot) => void;
	monitorDelayMs?: number;
	fetch?: typeof fetch;
}

export interface AddMemberInput {
	name: string;
	brief: MemberBrief;
	kind?: Exclude<MemberKind, "a2a">;
	definition?: string;
	model?: string;
	group?: string;
	isolation?: Isolation;
	a2aAgent?: string;
}

const KIND_DEFINITION: Record<Exclude<MemberKind, "a2a" | "custom">, string> = {
	worker: "worker",
	verifier: "worker",
	reviewer: "reviewer",
	scout: "scout",
};

const READ_ONLY = new Set(["edit", "write", "bash"]);

const VERIFIER_PROMPT = `You are a verifier: you check other members' work. Read the diffs and reports they post,
run the project's tests, typecheck and linters against the landed result, and confirm existing tests
were not weakened or deleted. Report each problem to the member that wrote the code with @name and
the exact failing command and output. Never fix other members' code yourself.`;

function isKilled(member: Member): boolean {
	return member.status === "killed";
}

export class Swarm {
	readonly id = crypto.randomUUID();
	readonly board = new Board();
	readonly createdAt = new Date().toISOString();
	status: "running" | "finished" = "running";
	summary?: string;
	private readonly handles = new Map<string, ChildHandle>();
	private readonly pendingWake = new Set<string>();
	private wakeScheduled = false;
	private monitorTimer: ReturnType<typeof setTimeout> | undefined;
	private monitorFiredAt = -1;
	private readonly busy = new Set<string>();
	/** Each member's in-flight run, settled once its outcome is handled. */
	private readonly runs = new Map<string, Promise<void>>();
	private readonly maxTurns = new Map<string, number>();
	private disposed = false;

	readonly config: SwarmConfig;
	private readonly deps: SwarmDeps;

	constructor(config: SwarmConfig, deps: SwarmDeps) {
		this.config = config;
		this.deps = deps;
		if (config.isolation === "worktree" && !deps.repo)
			throw new Error('Worktree isolation needs a git repository; use isolation "shared".');
		this.post("system", `Swarm "${config.title}" started.`, "system", []);
	}

	get title(): string {
		return this.config.title;
	}

	snapshot(): SwarmSnapshot {
		return {
			id: this.id,
			parentSessionId: this.deps.parentSessionId,
			title: this.config.title,
			status: this.status,
			...(this.summary !== undefined ? { summary: this.summary } : {}),
			createdAt: this.createdAt,
			config: { ...this.config },
			members: [...this.board.members.values()].map((m) => ({ ...m })),
			posts: [...this.board.posts],
			graph: this.board.graph(),
		};
	}

	private changed(): void {
		if (this.disposed) return;
		this.deps.onChange(this.snapshot());
		this.scheduleMonitor();
	}

	/** Appends to the board and wakes every recipient. */
	post(from: string, text: string, kind: PostKind, to: readonly string[] = []): Post {
		const post = this.board.post(from, text, kind, to);
		const fromMember = this.board.get(from) !== undefined;
		if (post.to.length === 0 && fromMember && (kind === "report" || kind === "message"))
			post.to.push(COORDINATOR);
		for (const recipient of post.to) this.deliver(recipient);
		this.changed();
		return post;
	}

	private deliver(name: string): void {
		if (name === COORDINATOR) {
			this.deps.notifyCoordinator();
			return;
		}
		const member = this.board.get(name);
		if (!member || member.status === "killed") return;
		if (member.phase === "gating" || member.phase === "reviewing") return;
		this.pendingWake.add(name);
		if (!this.wakeScheduled) {
			this.wakeScheduled = true;
			queueMicrotask(() => this.flushWakes());
		}
	}

	private flushWakes(): void {
		this.wakeScheduled = false;
		const names = [...this.pendingWake];
		this.pendingWake.clear();
		for (const name of names) {
			const member = this.board.get(name);
			if (!member || member.status === "killed" || this.disposed) continue;
			if (member.kind === "a2a" ? member.status === "active" : !this.handles.has(name)) continue;
			const unread = this.board.takeUnread(name);
			if (unread.length === 0) continue;
			const text = formatPosts(unread);
			if (member.kind === "a2a") void this.sendA2A(member, text);
			else if (member.status === "active")
				void this.handles
					.get(name)
					?.steer(wakePrompt(text))
					.catch(() => {});
			else this.startRun(member, wakePrompt(text));
		}
	}

	/** Undoes a member that never started: its child, registry entry, worktree, branch and roster row. */
	private async discardUnstarted(member: Member): Promise<void> {
		this.board.members.delete(member.name);
		this.maxTurns.delete(member.name);
		const child = this.handles.get(member.name);
		this.handles.delete(member.name);
		if (child) {
			forgetMember(child.sessionId);
			await child.dispose().catch(() => {});
		}
		if (member.worktree && this.deps.repo)
			await removeWorktree(
				{ ...member.worktree, repo: this.deps.repo },
				{ deleteBranch: true },
			).catch(() => {});
	}

	async addMember(input: AddMemberInput): Promise<Member> {
		this.assertRunning();
		const kind: MemberKind = input.a2aAgent
			? "a2a"
			: (input.kind ?? (input.definition ? "custom" : "worker"));
		const member: Member = {
			name: input.name,
			...(input.group ? { group: input.group } : {}),
			kind,
			...(input.definition ? { definition: input.definition } : {}),
			status: "waiting",
			phase: "working",
			brief: input.brief,
			readCursor: 0,
			fixRounds: 0,
			createdAt: new Date().toISOString(),
			...(input.a2aAgent ? { a2a: { agent: input.a2aAgent } } : {}),
		};
		this.board.add(member);
		try {
			if (kind !== "a2a") await this.spawn(member, input);
		} catch (error) {
			await this.discardUnstarted(member);
			throw error;
		}
		if (this.disposed || this.status !== "running") {
			await this.discardUnstarted(member);
			throw new Error("This swarm has finished.");
		}
		const brief = [
			`@${member.name} joins as ${kind}${member.model ? ` on ${member.model}` : ""}.`,
			member.brief.task,
			member.brief.owns.length ? `Owns: ${member.brief.owns.join(", ")}` : "",
			member.brief.avoid.length ? `Must not touch: ${member.brief.avoid.join(", ")}` : "",
			member.brief.done ? `Done when: ${member.brief.done}` : "",
		]
			.filter(Boolean)
			.join("\n");
		const briefPost = this.board.post(COORDINATOR, brief, "brief", []);
		const early = this.board.takeUnread(member.name).filter((p) => p.seq !== briefPost.seq);
		const start = early.length
			? `${member.brief.task}\n\n${wakePrompt(formatPosts(early))}`
			: member.brief.task;
		if (kind === "a2a") void this.sendA2A(member, start);
		else this.startRun(member, `Start on your brief.\n\n${start}`);
		this.changed();
		return member;
	}

	private definitionFor(member: Member, input: AddMemberInput): AgentDefinition {
		const wanted =
			input.definition ??
			KIND_DEFINITION[member.kind as Exclude<MemberKind, "a2a" | "custom">] ??
			"worker";
		const definition = this.deps.definitions().find((d) => d.name === wanted);
		if (!definition)
			throw new Error(
				`Unknown agent definition "${wanted}". Available: ${this.deps
					.definitions()
					.map((d) => d.name)
					.join(", ")}`,
			);
		if (member.kind !== "verifier") return definition;
		return { ...definition, systemPrompt: `${VERIFIER_PROMPT}\n\n${definition.systemPrompt}` };
	}

	private async spawn(member: Member, input: AddMemberInput): Promise<void> {
		const definition = this.definitionFor(member, input);
		const isolation =
			input.isolation ??
			(member.kind === "verifier" || member.kind === "scout" || member.kind === "reviewer"
				? "shared"
				: this.config.isolation);
		if (isolation === "worktree") {
			if (!this.deps.repo) throw new Error("Worktree isolation needs a git repository.");
			const worktree = await createWorktree({
				repo: this.deps.repo,
				root: this.deps.worktreeRoot,
				swarm: this.config.title,
				swarmId: this.id.slice(0, 8),
				seed: true,
				member: member.name,
			});
			member.worktree = { path: worktree.path, branch: worktree.branch, base: worktree.base };
			for (const command of this.config.setup) {
				const result = await run(command, [], {
					cwd: worktree.path,
					shell: true,
					timeoutMs: 15 * 60_000,
				});
				if (result.code !== 0) {
					await removeWorktree({ ...worktree }, { deleteBranch: true });
					throw new Error(
						`Setup "${command}" failed in @${member.name}'s worktree:\n${result.stderr.slice(-2000)}`,
					);
				}
			}
		}
		const cwd = member.worktree?.path ?? this.deps.cwd;
		const mapping = toSpawnMapping(definition, {
			cwd,
			availableModels: this.deps.availableModels(),
			...(input.model !== undefined ? { model: input.model } : {}),
		});
		const readOnly = member.kind === "scout" || member.kind === "reviewer";
		const tools = mapping.session.tools
			? [...mapping.session.tools.filter((t) => !readOnly || !READ_ONLY.has(t)), ...MEMBER_TOOLS]
			: undefined;
		const session: SessionOptions = {
			...mapping.session,
			...(tools ? { tools } : {}),
			...(readOnly && !tools
				? { excludeTools: [...(mapping.session.excludeTools ?? []), ...READ_ONLY] }
				: {}),
			systemPrompt: `${mapping.session.systemPrompt}\n\n${memberBridge({
				title: this.config.title,
				member,
				roster: [...this.board.members.values()],
				gates: this.config.gates,
				review: this.config.review,
			})}`,
			contextFiles: true,
			extensions: true,
		};
		const worktreePath = member.worktree?.path;
		const child = await this.deps.service.createChild({
			parent: this.deps.parentSessionId,
			visibility: "hidden",
			info: {
				createdBy: "tool:swarm_add",
				roleName: member.name,
				roleSource: definition.source,
				detached: true,
			},
			session,
			...(worktreePath
				? { workspace: { prepare: async () => ({ cwd: worktreePath, dispose: () => undefined }) } }
				: {}),
		});
		if (session.model) member.model = `${session.model.provider}/${session.model.id}`;
		member.childSessionId = child.sessionId;
		this.handles.set(member.name, child);
		rememberMember(child.sessionId, { swarm: this, member: member.name });
		if (mapping.maxTurns !== undefined) this.maxTurns.set(member.name, mapping.maxTurns);
	}

	private startRun(member: Member, task: string): void {
		const child = this.handles.get(member.name);
		if (!child) return;
		member.status = "active";
		member.activity = "starting";
		delete member.error;
		delete member.landed;
		member.phase = "working";
		this.busy.add(member.name);
		const maxTurns = this.maxTurns.get(member.name);
		const settled = child
			.runQueued(task, {
				...(maxTurns !== undefined ? { maxTurns } : {}),
				onUpdate: (details) => {
					if (details.activity && details.activity !== member.activity) {
						member.activity = details.activity;
						this.changed();
					}
				},
			})
			.then(
				(outcome) => this.onRunEnd(member, outcome),
				(error: unknown) =>
					this.onRunEnd(member, {
						status: "error",
						errorMessage: error instanceof Error ? error.message : String(error),
					} as RunOutcome),
			);
		this.runs.set(member.name, settled);
		this.changed();
	}

	private onRunEnd(
		member: Member,
		outcome: Pick<RunOutcome, "status" | "finalText" | "errorMessage">,
	): void {
		this.busy.delete(member.name);
		if (isKilled(member) || this.disposed) return;
		delete member.activity;
		if (outcome.status === "error") {
			member.status = "paused";
			member.error = outcome.errorMessage ?? "run failed";
			this.post(MONITOR, `@${member.name} paused after an error: ${member.error}`, "system", [
				COORDINATOR,
			]);
			return;
		}
		member.status = "waiting";
		const text = outcome.finalText?.trim();
		if (text) this.post(member.name, text, "report");
		if (member.doneClaim !== undefined && outcome.status === "completed")
			void this.runQuality(member);
		else this.changed();
		if (this.board.posts.some((p) => p.seq > member.readCursor && p.to.includes(member.name)))
			this.deliver(member.name);
	}

	/** Member tool: claims the brief is done; quality runs when the member's turn ends. */
	claimDone(name: string, summary: string): string {
		const member = this.board.require(name);
		member.doneClaim = summary;
		this.changed();
		const checks =
			member.kind === "worker" || member.kind === "custom"
				? "Your ownership, quality gates and review run when you end this turn."
				: "Recorded.";
		return `${checks} End your turn now.`;
	}

	private async runQuality(member: Member): Promise<void> {
		await this.qualityPipeline(member);
		if (isKilled(member) || this.disposed || member.status === "active") return;
		if (this.board.posts.some((p) => p.seq > member.readCursor && p.to.includes(member.name)))
			this.deliver(member.name);
	}

	private async qualityPipeline(member: Member): Promise<void> {
		const summary = member.doneClaim ?? "";
		delete member.doneClaim;
		const checked = member.kind === "worker" || member.kind === "custom";
		if (!checked) {
			member.phase = "done";
			this.post(member.name, `Done: ${summary}`, "report", [COORDINATOR]);
			return;
		}
		member.phase = "gating";
		member.activity = "running quality gates";
		this.changed();
		const cwd = member.worktree?.path ?? this.deps.cwd;
		const problems: string[] = [];
		try {
			if (member.worktree) {
				member.changedFiles = await changedFiles(cwd);
				member.ownershipViolations = ownershipViolations(member.changedFiles, member.brief);
				if (member.ownershipViolations.length)
					problems.push(
						`You changed files outside your brief: ${member.ownershipViolations.join(", ")}. Revert them or ask @coordinator to widen what you own.`,
					);
			}
			if (problems.length === 0 && this.config.gates.length) {
				member.gates = await runGates(this.config.gates, cwd);
				if (member.gates.some((g) => !g.ok))
					problems.push(`Quality gates failed:\n${describeGates(member.gates)}`);
			}
			if (isKilled(member) || this.disposed) return;
			if (
				problems.length === 0 &&
				this.config.review &&
				(!member.worktree || member.changedFiles?.length)
			) {
				member.phase = "reviewing";
				member.activity = "under review";
				this.changed();
				const review = await this.review(member);
				member.review = review;
				if (review.verdict === "changes")
					problems.push(`The reviewer requested changes:\n${review.summary}`);
			}
		} catch (error) {
			problems.push(
				`The quality pipeline failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		delete member.activity;
		if (isKilled(member) || this.disposed) return;
		if (problems.length) {
			member.fixRounds += 1;
			member.phase = "needs-fixes";
			if (member.fixRounds > this.config.maxFixRounds) {
				this.post(
					"gates",
					`@coordinator @${member.name} is still failing after ${this.config.maxFixRounds} fix rounds:\n${problems.join("\n\n")}`,
					"gate",
					[COORDINATOR],
				);
				return;
			}
			this.post("gates", `@${member.name}\n${problems.join("\n\n")}`, "gate", [member.name]);
			return;
		}
		const stat = member.worktree ? (await worktreeDiff(cwd).catch(() => ({ stat: "" }))).stat : "";
		if (isKilled(member) || this.disposed) return;
		member.phase = "done";
		this.post(
			"gates",
			`@coordinator @${member.name} passed${member.worktree ? " ownership," : ""} ${
				this.config.gates.length ? "gates" : "no gates"
			}${this.config.review ? " and review" : ""}${member.worktree ? ` — ready to land from ${member.worktree.branch}` : ""}.\n${summary}${stat ? `\n${stat}` : ""}`,
			"gate",
			[COORDINATOR],
		);
	}

	private async review(member: Member): Promise<NonNullable<Member["review"]>> {
		const cwd = member.worktree?.path ?? this.deps.cwd;
		const { patch, stat } = member.worktree
			? await worktreeDiff(cwd)
			: { patch: (await run("git", ["diff", "HEAD"], { cwd })).stdout, stat: "" };
		const definition = this.deps.definitions().find((d) => d.name === "reviewer");
		if (!definition)
			return {
				verdict: "approve",
				summary: "No reviewer definition is available; review skipped.",
			};
		const mapping = toSpawnMapping(definition, {
			cwd,
			availableModels: this.deps.availableModels(),
		});
		const child = await this.deps.service.createChild({
			parent: this.deps.parentSessionId,
			visibility: "hidden",
			info: {
				createdBy: "swarm:review",
				roleName: `review-${member.name}`,
				roleSource: definition.source,
			},
			session: {
				...mapping.session,
				tools: (definition.tools ?? ["read", "grep", "find", "ls"]).filter(
					(t) => !READ_ONLY.has(t),
				),
				contextFiles: true,
			},
			...(member.worktree
				? { workspace: { prepare: async () => ({ cwd, dispose: () => undefined }) } }
				: {}),
		});
		try {
			const outcome = await child.runQueued(
				reviewTask({ member, stat, patch }),
				mapping.maxTurns ? { maxTurns: mapping.maxTurns } : {},
			);
			const text = outcome.finalText ?? outcome.errorMessage ?? "";
			const verdict = reviewVerdict(text);
			const approved = outcome.status === "completed" && verdict === "APPROVE";
			return {
				verdict: approved ? "approve" : "changes",
				summary:
					approved || verdict === "CHANGES_REQUESTED"
						? text
						: `${text}\n(The review did not complete with an explicit approval, so it counts as changes requested.)`,
				reviewerSessionId: child.sessionId,
			};
		} finally {
			await child.dispose().catch(() => {});
		}
	}

	private async sendA2A(member: Member, text: string): Promise<void> {
		const state = member.a2a;
		if (!state) return;
		member.status = "active";
		member.activity = "waiting on remote agent";
		this.changed();
		try {
			const client = new A2AClient(
				this.deps.resolveA2A(state.agent),
				this.deps.fetch ? { fetch: this.deps.fetch } : {},
			);
			const message: Message = textMessage("user", text, {
				...(state.contextId ? { contextId: state.contextId } : {}),
				...(state.taskId ? { taskId: state.taskId } : {}),
			});
			let result: Task | Message = await client.sendMessage({
				message,
				configuration: { blocking: false },
			});
			if (isTask(result)) {
				state.taskId = result.id;
				state.contextId = result.contextId;
				if (!settled(result)) result = await client.waitForTask(result);
				if (settled(result) && result.status.state !== "input-required") delete state.taskId;
			} else if (result.contextId) state.contextId = result.contextId;
			if (isKilled(member)) return;
			member.status = "waiting";
			delete member.activity;
			this.post(member.name, describeResult(result), "report");
			if (this.board.posts.some((p) => p.seq > member.readCursor && p.to.includes(member.name)))
				this.deliver(member.name);
		} catch (error) {
			if (isKilled(member)) return;
			member.status = "paused";
			member.error = error instanceof Error ? error.message : String(error);
			delete member.activity;
			this.post(MONITOR, `@${member.name} (A2A ${state.agent}) failed: ${member.error}`, "system", [
				COORDINATOR,
			]);
		}
	}

	async land(name: string): Promise<string> {
		const member = this.board.require(name);
		if (!member.worktree)
			return `@${member.name} works in the shared tree; its changes are already there.`;
		if (member.status === "active" || member.phase !== "done")
			throw new Error(
				`@${member.name} is ${member.status === "active" ? "still working" : `in phase "${member.phase}"`}: only work that passed ownership, gates and review can be landed. Wait for its gate report.`,
			);
		const { patch, stat } = await worktreeDiff(member.worktree.path);
		if (!patch.trim()) return `@${member.name} has no changes to land.`;
		const applied = await applyPatch(this.deps.cwd, patch);
		if (!applied.ok) {
			this.post(
				"gates",
				`Landing @${member.name} failed — it conflicts with the coordinator's tree, which was left unchanged. Resolve it by hand from branch ${member.worktree.branch}:\n${applied.error}`,
				"gate",
				[COORDINATOR],
			);
			throw new Error(`Landing @${name} conflicts:\n${applied.error}`);
		}
		member.landed = true;
		this.post(
			"gates",
			`Landed @${member.name} from ${member.worktree.branch} into the coordinator's working tree, uncommitted.\n${stat}`,
			"system",
			[],
		);
		return `Landed @${name}:\n${stat}`;
	}

	async diff(name: string): Promise<{ patch: string; stat: string }> {
		const member = this.board.require(name);
		if (!member.worktree) return { patch: "", stat: "" };
		return worktreeDiff(member.worktree.path);
	}

	async remove(name: string, force = false): Promise<string> {
		const member = this.board.require(name);
		if (member.status === "killed") return `@${member.name} was already removed.`;
		const child = this.handles.get(member.name);
		await child?.abort("removed").catch(() => {});
		await this.runs.get(member.name);
		const files = member.worktree ? await changedFiles(member.worktree.path) : [];
		if (files.length && !member.landed && !force)
			throw new Error(
				`Stopped @${member.name}, but it has ${files.length} unlanded changed file(s). swarm_land it first, or pass force to discard them.`,
			);
		member.status = "killed";
		delete member.activity;
		this.handles.delete(member.name);
		if (child) {
			forgetMember(child.sessionId);
			await child.dispose().catch(() => {});
		}
		if (member.worktree && this.deps.repo)
			await removeWorktree(
				{ ...member.worktree, repo: this.deps.repo },
				{ deleteBranch: files.length === 0 || !!member.landed },
			);
		this.post(COORDINATOR, `Removed @${member.name}.`, "system", []);
		return `Removed @${member.name}.`;
	}

	finish(summary: string): void {
		this.status = "finished";
		this.summary = summary;
		if (this.monitorTimer) clearTimeout(this.monitorTimer);
		this.post(COORDINATOR, `Swarm finished: ${summary}`, "system", []);
	}

	private assertRunning(): void {
		if (this.status !== "running" || this.disposed) throw new Error("This swarm has finished.");
	}

	/** Every member asleep, nobody mid-pipeline, work not finished. */
	private membersQuiet(): boolean {
		if (this.status !== "running" || this.disposed) return false;
		const live = [...this.board.members.values()].filter((m) => m.status !== "killed");
		if (live.length === 0) return false;
		if (this.busy.size || this.pendingWake.size) return false;
		if (live.some((m) => m.status === "active" || m.phase === "gating" || m.phase === "reviewing"))
			return false;
		return !live.every((m) => m.phase === "done");
	}

	private coordinatorQuiet(): boolean {
		return this.deps.isCoordinatorIdle() && this.board.coordinatorCursor >= this.board.posts.length;
	}

	private scheduleMonitor(): void {
		if (this.monitorTimer) clearTimeout(this.monitorTimer);
		if (!this.membersQuiet() || this.monitorFiredAt === this.board.posts.length) return;
		this.monitorTimer = setTimeout(() => {
			this.monitorTimer = undefined;
			if (!this.membersQuiet() || this.monitorFiredAt === this.board.posts.length) return;
			if (!this.coordinatorQuiet()) {
				this.scheduleMonitor();
				return;
			}
			const open = [...this.board.members.values()]
				.filter((m) => m.status !== "killed" && m.phase !== "done")
				.map((m) => `@${m.name} (${m.status}, ${m.phase})`);
			this.post(
				MONITOR,
				`@coordinator every member has gone quiet but the work is not done. Still open: ${open.join(", ")}. Mention whoever can move it forward, or finish the swarm.`,
				"system",
				[COORDINATOR],
			);
			this.monitorFiredAt = this.board.posts.length;
		}, this.deps.monitorDelayMs ?? 5000);
	}

	/** The coordinator's unread posts; advances its cursor. */
	takeCoordinatorPosts(): Post[] {
		const posts = this.board.takeUnread(COORDINATOR);
		if (posts.length) this.scheduleMonitor();
		return posts;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.monitorTimer) clearTimeout(this.monitorTimer);
		await Promise.allSettled(
			[...this.handles.entries()].map(async ([, child]) => {
				forgetMember(child.sessionId);
				await child.abort("swarm disposed").catch(() => {});
				await child.dispose();
			}),
		);
		this.handles.clear();
	}
}
