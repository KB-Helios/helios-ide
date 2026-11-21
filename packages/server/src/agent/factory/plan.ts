import type { DagDefinition } from "pi-dag";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { ModelRef, RoleSelection, ThinkingLevel } from "../factoryReview/roles";
import {
	type FactoryCoderPlan,
	INTEGRATE_NODE,
	LAND_NODE,
	mayOverlap,
	RELEASE_NODE,
} from "./template";

/** The planning DAG's one node, and the one json output it must submit. */
export const PLANNER_NODE_ID = "planner";
export const PLAN_PORT = "plan";
/** Read-only pi tools: a planner looks at the repository, it can neither write nor run anything. */
export const PLANNER_TOOLS = ["read", "grep", "find", "ls"] as const;

export const MAX_PLAN_CODERS = 8;
export const MAX_TASK_CHARS = 8000;
export const MAX_GLOBS = 64;
const MAX_GLOB_CHARS = 512;
const CODER_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** Ids the template or the review hook already uses; a plan may not shadow them. */
const RESERVED_IDS: ReadonlySet<string> = new Set([
	RELEASE_NODE,
	INTEGRATE_NODE,
	LAND_NODE,
	"review",
	PLANNER_NODE_ID,
]);

export class PlanError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PlanError";
	}
}

function globList(value: unknown, what: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_GLOBS)
		throw new PlanError(`${what} must be a list of at most ${MAX_GLOBS} globs`);
	return value.map((glob) => {
		if (typeof glob !== "string" || glob.length === 0 || glob.length > MAX_GLOB_CHARS)
			throw new PlanError(`${what} holds an invalid glob`);
		const normalized = glob.replace(/\\/g, "/");
		if (
			normalized.includes("\0") ||
			normalized.startsWith("/") ||
			/^[A-Za-z]:/.test(normalized) ||
			normalized.split("/").includes("..")
		)
			throw new PlanError(`${what} glob "${glob}" must stay inside the repository`);
		return glob;
	});
}

/**
 * Validates the coders a planner (or a person) proposes, strictly and on the host. Anything unexpected
 * rejects the whole plan: a half-trusted plan would let a model choose what the template builds. Checks
 * bounds, ids (plain, unique, not reserved), globs that stay inside the repository, ownership that is
 * given when several coders run and disjoint between them. Throws `PlanError` with a plain reason.
 */
export function parseCoderPlans(value: unknown): FactoryCoderPlan[] {
	const list = Array.isArray(value)
		? value
		: value && typeof value === "object" && !Array.isArray(value)
			? (value as { coders?: unknown }).coders
			: undefined;
	if (value && !Array.isArray(value) && typeof value === "object") {
		const extra = Object.keys(value).filter((key) => key !== "coders");
		if (extra.length) throw new PlanError(`The plan has unexpected fields: ${extra.join(", ")}`);
	}
	if (!Array.isArray(list) || list.length === 0)
		throw new PlanError("The plan must list at least one coder");
	if (list.length > MAX_PLAN_CODERS)
		throw new PlanError(`The plan may have at most ${MAX_PLAN_CODERS} coders`);
	const seen = new Set<string>();
	const coders = list.map((entry, index): FactoryCoderPlan => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry))
			throw new PlanError(`Coder ${index + 1} is not an object`);
		const raw = entry as Record<string, unknown>;
		const extra = Object.keys(raw).filter((key) => !["id", "task", "owns", "avoid"].includes(key));
		if (extra.length)
			throw new PlanError(`Coder ${index + 1} has unexpected fields: ${extra.join(", ")}`);
		const id = raw.id;
		if (typeof id !== "string" || !CODER_ID.test(id))
			throw new PlanError(
				`Coder ${index + 1} needs an id of lower-case letters, digits and dashes (at most 32, starting with a letter)`,
			);
		if (RESERVED_IDS.has(id) || id.startsWith("gate-"))
			throw new PlanError(`Coder id ${id} is reserved`);
		if (seen.has(id)) throw new PlanError(`Coder id ${id} is used twice`);
		seen.add(id);
		const task = raw.task;
		if (typeof task !== "string" || task.trim().length === 0 || task.length > MAX_TASK_CHARS)
			throw new PlanError(`Coder ${id} needs a task of at most ${MAX_TASK_CHARS} characters`);
		const owns = globList(raw.owns, `Coder ${id} owns`);
		const avoid = globList(raw.avoid, `Coder ${id} avoid`);
		return {
			id,
			task: task.trim(),
			...(owns.length ? { owns } : {}),
			...(avoid.length ? { avoid } : {}),
		};
	});
	for (const [index, coder] of coders.entries()) {
		if (coders.length > 1 && !coder.owns?.length)
			throw new PlanError(`Coder ${coder.id} needs owns globs when several coders run in parallel`);
		for (const other of coders.slice(index + 1))
			if (mayOverlap(coder.owns ?? [], other.owns ?? []))
				throw new PlanError(
					`Coders ${coder.id} and ${other.id} may touch the same files; their owns globs must be disjoint`,
				);
	}
	return coders;
}

const ModelRefSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1, maxLength: 128 }),
		id: Type.String({ minLength: 1, maxLength: 256 }),
	},
	{ additionalProperties: false },
);
const Selection = Type.Object(
	{
		model: ModelRefSchema,
		thinkingLevel: Type.Union(
			(["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const).map((level) =>
				Type.Literal(level),
			),
		),
	},
	{ additionalProperties: false },
);
const PlanRunSchema = Type.Object(
	{
		title: Type.String({ maxLength: 120 }),
		target: Type.String({ minLength: 1, maxLength: 256 }),
		gateRetries: Type.Integer({ minimum: 0, maximum: 5 }),
		notes: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 8 }),
		roles: Type.Object(
			{ coder: Selection, reviewer: Selection, scout: Selection },
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/**
 * What the person chose when the run was started, frozen into the planning DAG's planner node (its system
 * prompt) so the factory DAG built later uses exactly those roles, target and budget: not what a model
 * writes in its plan, and not whatever the host would pick again.
 */
export interface PlanRun {
	title: string;
	target: string;
	gateRetries: number;
	notes: string[];
	roles: Record<"coder" | "reviewer" | "scout", { model: ModelRef; thinkingLevel: ThinkingLevel }>;
}

const OPEN = "<factory-plan>";
const CLOSE = "</factory-plan>";

export function encodePlanRun(run: PlanRun): string {
	// No "<" in the payload, so a value containing a marker cannot cut the frame; JSON.parse restores it.
	return `${OPEN}${JSON.stringify(run).replace(/</g, "\\u003c")}${CLOSE}`;
}

export function parsePlanRun(systemPrompt: string | undefined): PlanRun | undefined {
	if (!systemPrompt) return undefined;
	const start = systemPrompt.lastIndexOf(OPEN);
	const end = start < 0 ? -1 : systemPrompt.indexOf(CLOSE, start);
	if (end < 0) return undefined;
	try {
		const value: unknown = JSON.parse(systemPrompt.slice(start + OPEN.length, end));
		return Check(PlanRunSchema, value) ? (value as PlanRun) : undefined;
	} catch {
		return undefined;
	}
}

/** The role choices a plan run keeps: everything the factory DAG needs except the planner itself. */
export function planRunRoles(
	roles: Record<"coder" | "reviewer" | "scout", RoleSelection>,
): PlanRun["roles"] {
	const keep = (role: RoleSelection) => ({ model: role.model, thinkingLevel: role.thinkingLevel });
	return { coder: keep(roles.coder), reviewer: keep(roles.reviewer), scout: keep(roles.scout) };
}

const PLANNER_PROMPT = [
	"You are the planner of a software factory. You read the repository; you never change anything.",
	"Split the task into the smallest set of independent coder tasks that can run in parallel.",
	"Each coder works alone in its own git worktree and may only change the files it owns.",
].join("\n");

function plannerTask(task: string): string {
	return [
		"Task to plan:",
		task,
		"",
		"Explore the repository with your read-only tools, then submit exactly one output, `plan`, as {kind:'json'} with this shape:",
		'{"coders":[{"id":"short-name","task":"what this coder must do, self-contained","owns":["src/area/**"],"avoid":["src/area/generated/**"]}]}',
		`Rules: 1 to ${MAX_PLAN_CODERS} coders. id: lower-case letters, digits and dashes, starting with a letter, at most 32, unique, never "release", "land", "integrate", "review", "planner" or starting with "gate-". task: at most ${MAX_TASK_CHARS} characters and understandable without the others.`,
		"owns: globs relative to the repository root that the coder may change. Required when you plan more than one coder, and the globs of different coders must not overlap (a coder may not own a folder another coder owns anything in). Use a single coder when the work cannot be split cleanly.",
		"Do not plan package manifests, lockfiles or build configuration unless the task is about them. Do not add a reviewer, gate or release step: the factory adds those and a person approves the release.",
	].join("\n");
}

/**
 * The planning DAG: one read-only planner node whose json `plan` output a **person must approve** before
 * anything is built from it. Approval only unlocks `dag.startFromPlan`; the factory DAG it creates has its
 * own human release, so a plan never reaches the checkout without a person deciding twice.
 */
export function buildPlanningDefinition(options: {
	task: string;
	planner: RoleSelection;
	run: PlanRun;
}): DagDefinition {
	return {
		title: `Plan: ${options.run.title}`,
		defaults: { tools: [] },
		maxConcurrent: 1,
		nodes: [
			{
				id: PLANNER_NODE_ID,
				task: plannerTask(options.task),
				session: {
					model: options.planner.model,
					thinkingLevel: options.planner.thinkingLevel,
					tools: [...PLANNER_TOOLS],
					systemPrompt: `${PLANNER_PROMPT}\n\n${encodePlanRun(options.run)}`,
				},
				outputs: { [PLAN_PORT]: { kind: "json" } },
				approval: {
					authority: "human",
					question:
						"The planner proposes how to split the task into coders. Read the plan output first. Approve to allow creating the factory run from it; reject with the reason to keep it blocked, then retry the step.",
				},
			},
		],
		connections: [],
	};
}

/** A planner node declares exactly one output, the json `plan` port. */
export function isPlannerNode(outputs: Record<string, { kind: string }>): boolean {
	const ports = Object.keys(outputs);
	return ports.length === 1 && ports[0] === PLAN_PORT && outputs[PLAN_PORT]?.kind === "json";
}
