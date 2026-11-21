import type { Api, Model } from "@earendil-works/pi-ai";
import { accountAvailableModels } from "../modelAvailability";
import { getPiRuntime } from "../piRuntime";

/**
 * Model roles of the AI factory (ai-factory.md step 4). A role is a recipe for one kind of node; the
 * definition stays authoritative because the resolution below writes plain `session.model` /
 * `session.thinkingLevel` into the node specs — pi-dag records what each node actually ran on.
 */
export type FactoryRole = "planner" | "coder" | "reviewer" | "scout";
export const FACTORY_ROLES: readonly FactoryRole[] = ["planner", "coder", "reviewer", "scout"];

export interface ModelRef {
	provider: string;
	id: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** The slice of a pi model the resolution reads; any `Model<Api>` satisfies it. */
export interface RoleCandidate extends ModelRef {
	reasoning?: boolean;
	contextWindow?: number;
	cost?: { input: number; output: number };
}

export interface RoleSelection {
	model: ModelRef;
	thinkingLevel: ThinkingLevel;
	family: string;
}

/** A recorded departure from the ideal assignment; it is returned with the roles, never silent. */
export interface RoleNote {
	role: FactoryRole;
	kind: "same-family-reviewer";
	message: string;
}

export interface ResolvedRoles {
	roles: Record<FactoryRole, RoleSelection>;
	notes: RoleNote[];
}

export interface ResolveRolesOptions {
	/** Explicit choice per role (a person's pick); it wins over every heuristic. */
	overrides?: Partial<Record<FactoryRole, ModelRef>>;
	/** The host's default model: the coder's starting point when no override names one. */
	preferred?: ModelRef;
	/**
	 * Reviewer independence is the point of the review, so the default is to fail when no other family is
	 * available. `true` falls back to the coder's model and records a `same-family-reviewer` note.
	 */
	allowSameFamilyReviewer?: boolean;
}

export class FactoryRoleError extends Error {
	readonly code: "no-models" | "unknown-override" | "no-cross-family-reviewer";
	constructor(code: FactoryRoleError["code"], message: string) {
		super(message);
		this.name = "FactoryRoleError";
		this.code = code;
	}
}

const FAMILY_BY_MODEL_ID: ReadonlyArray<readonly [RegExp, string]> = [
	[/claude|anthropic/i, "anthropic"],
	[/(^|[/:._-])(gpt|o[1-9]|codex|chatgpt)([/:._-]|\d|$)|openai/i, "openai"],
	[/gemini|gemma|google/i, "google"],
	[/grok|xai/i, "xai"],
	[/kimi|moonshot/i, "moonshot"],
	[/glm|zai|zhipu/i, "zai"],
	[/deepseek/i, "deepseek"],
	[/qwen/i, "qwen"],
	[/mistral|devstral|codestral/i, "mistral"],
	[/llama|muse/i, "meta"],
	[/minimax/i, "minimax"],
	// Bedrock hosts several vendors; Amazon's own models are a family of their own.
	[/(^|[./])(nova|titan)/i, "amazon"],
];

const FAMILY_BY_PROVIDER: ReadonlyArray<readonly [RegExp, string]> = [
	// Not `bedrock`: it is multi-vendor, so a Bedrock model's family comes from its model id only.
	[/^anthropic/i, "anthropic"],
	[/^openai|^azure|codex/i, "openai"],
	[/^google/i, "google"],
	[/^xai$/i, "xai"],
	[/^(moonshotai|kimi)/i, "moonshot"],
	[/^zai/i, "zai"],
	[/^deepseek$/i, "deepseek"],
	[/^mistral$/i, "mistral"],
];

/**
 * The vendor family a model belongs to. The model id wins (an aggregator such as openrouter serves
 * `anthropic/claude-...`), then the provider id; anything unrecognised is its own family named after its
 * provider, so two unknown providers never count as the same family.
 */
export function modelFamily(ref: ModelRef): string {
	for (const [pattern, family] of FAMILY_BY_MODEL_ID) if (pattern.test(ref.id)) return family;
	for (const [pattern, family] of FAMILY_BY_PROVIDER) if (pattern.test(ref.provider)) return family;
	// Bedrock hosts many vendors: its ids name the vendor first (`cohere.command-r…`, optionally behind a
	// region prefix such as `us.`), so unmatched Bedrock models get their vendor as the family.
	if (/bedrock/i.test(ref.provider)) {
		const segments = ref.id.split(".");
		const vendor = /^(us|eu|apac|us-gov|global)$/i.test(segments[0] ?? "")
			? segments[1]
			: segments[0];
		if (vendor && segments.length > 1) return `vendor:${vendor.toLowerCase()}`;
	}
	return `provider:${ref.provider}`;
}

const THINKING: Record<FactoryRole, ThinkingLevel> = {
	planner: "high",
	coder: "medium",
	reviewer: "high",
	scout: "off",
};

function key(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

function blended(model: RoleCandidate): number {
	return (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
}

/** Strongest first: reasoning models, then larger context, then provider/id for a stable order. */
function strongest(a: RoleCandidate, b: RoleCandidate): number {
	return (
		Number(b.reasoning ?? false) - Number(a.reasoning ?? false) ||
		(b.contextWindow ?? 0) - (a.contextWindow ?? 0) ||
		key(a).localeCompare(key(b))
	);
}

function selection(role: FactoryRole, model: RoleCandidate): RoleSelection {
	return {
		model: { provider: model.provider, id: model.id },
		// A model that cannot reason ignores a level; recording "off" keeps the definition honest.
		thinkingLevel: model.reasoning === false ? "off" : THINKING[role],
		family: modelFamily(model),
	};
}

/**
 * Picks one model per role from what the runtime can serve right now.
 *
 * - coder: override, else the host default, else the strongest available model.
 * - planner: override, else the coder's model (planning and coding share a family by default).
 * - scout: override, else the cheapest model of the coder's family, else the coder's model.
 * - reviewer: override, else the strongest model of a different family than the coder. With none,
 *   `FactoryRoleError("no-cross-family-reviewer")` — or, with `allowSameFamilyReviewer`, the coder's
 *   model plus a recorded `same-family-reviewer` note. An override in the coder's family is held to the
 *   same rule.
 */
export function resolveRoleModels(
	available: readonly RoleCandidate[],
	options: ResolveRolesOptions = {},
): ResolvedRoles {
	const pool = [...available].sort(strongest);
	const first = pool[0];
	if (!first)
		throw new FactoryRoleError("no-models", "No model is available for the factory roles");
	const byKey = new Map(pool.map((model) => [key(model), model]));
	const pick = (ref: ModelRef | undefined, role: FactoryRole): RoleCandidate | undefined => {
		if (!ref) return undefined;
		const found = byKey.get(key(ref));
		if (!found)
			throw new FactoryRoleError(
				"unknown-override",
				`The ${role} model ${key(ref)} is not available`,
			);
		return found;
	};
	const overrides = options.overrides ?? {};
	const preferred = options.preferred ? byKey.get(key(options.preferred)) : undefined;
	const coder = pick(overrides.coder, "coder") ?? preferred ?? first;
	const coderFamily = modelFamily(coder);
	const notes: RoleNote[] = [];

	const planner = pick(overrides.planner, "planner") ?? coder;
	const sameFamily = pool
		.filter((model) => modelFamily(model) === coderFamily)
		.sort((a, b) => blended(a) - blended(b) || key(a).localeCompare(key(b)));
	const scout = pick(overrides.scout, "scout") ?? sameFamily[0] ?? coder;

	let reviewer =
		pick(overrides.reviewer, "reviewer") ??
		pool.find((model) => modelFamily(model) !== coderFamily);
	if (!reviewer || modelFamily(reviewer) === coderFamily) {
		if (!options.allowSameFamilyReviewer)
			throw new FactoryRoleError(
				"no-cross-family-reviewer",
				`The reviewer must run on a different model family than the coder (${coderFamily}); none is available`,
			);
		reviewer = reviewer ?? coder;
		notes.push({
			role: "reviewer",
			kind: "same-family-reviewer",
			message: `The reviewer runs on ${key(reviewer)}, the same family (${coderFamily}) as the coder: no independent family was available`,
		});
	}

	return {
		roles: {
			planner: selection("planner", planner),
			coder: selection("coder", coder),
			reviewer: selection("reviewer", reviewer),
			scout: selection("scout", scout),
		},
		notes,
	};
}

/** The models the host's runtime can serve right now (provider credentials and listings applied). */
export async function availableFactoryModels(): Promise<readonly Model<Api>[]> {
	return accountAvailableModels(await getPiRuntime());
}

/**
 * `resolveRoleModels` over the live runtime. `include` narrows the pool (a person's allow-list); the
 * default is every model the runtime can serve.
 */
export async function resolveFactoryRoles(
	options: ResolveRolesOptions & { include?: (model: RoleCandidate) => boolean } = {},
): Promise<ResolvedRoles> {
	const { include, ...rest } = options;
	const models = await availableFactoryModels();
	return resolveRoleModels(include ? models.filter(include) : models, rest);
}
