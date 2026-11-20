import type { DagConnection, DagDefinition, DagNodeSpec } from "pi-dag";
import {
	DEFAULT_GATE_RETRIES,
	encodeFactoryNode,
	type FactoryNode,
	MAX_GATE_RETRIES,
	ROLE_TOOLS,
} from "./spec";

export interface FactoryCoderPlan {
	/** The coder node's id; also its worktree and branch name. */
	id: string;
	task: string;
	/** Globs this coder may change (empty: unrestricted, allowed only with a single coder). */
	owns?: string[];
	avoid?: string[];
}

/** Everything a hook needs to wire extra nodes into the factory graph. */
export interface BeforeReleaseContext {
	/** Coder node ids; pass them to `factoryInspector` for read-only access to their worktrees. */
	coders: string[];
	/** One gate node per coder, same order. */
	gates: string[];
	release: string;
	/** The output port every gate node publishes its report on. */
	gateOutput: string;
}

/**
 * Nodes inserted between the gates and the human release (a reviewer, say). The hook owns their
 * connections: from `gates`/`coders` outputs into its nodes, and from its nodes into the release node,
 * whose extra input ports it declares in `releaseInputs`. A reviewer's output port that feeds the release
 * node is what makes the release wait for its findings.
 */
export interface BeforeRelease {
	nodes: DagNodeSpec[];
	connections: DagConnection[];
	releaseInputs: NonNullable<DagNodeSpec["inputs"]>;
}

export interface FactoryPlan {
	title: string;
	/** The branch the main checkout must have checked out; landing refuses any other. */
	target: string;
	coders: FactoryCoderPlan[];
	maxConcurrent?: number;
	/**
	 * Gate corrections each coder gets per attempt: when its gates fail at submit, the host hands back the
	 * report and the coder fixes forward, at most this many times (default `DEFAULT_GATE_RETRIES`, at most
	 * `MAX_GATE_RETRIES`, `0` turns the loop off). The budget is written into each coder node.
	 */
	gateRetries?: number;
	/** The step-4 insertion point. Absent: gates feed the release node directly. */
	beforeRelease?: (context: BeforeReleaseContext) => BeforeRelease;
	/** Per-role model choice written into each template node's session; absent roles use DAG defaults. */
	models?: Partial<Record<TemplateRole, RoleModel>>;
}

export type TemplateRole = "coder" | "gate" | "release" | "land";
export interface RoleModel {
	model: NonNullable<NonNullable<DagNodeSpec["session"]>["model"]>;
	thinkingLevel?: NonNullable<DagNodeSpec["session"]>["thinkingLevel"];
}

function withModel(spec: DagNodeSpec, choice: RoleModel | undefined): DagNodeSpec {
	if (!choice) return spec;
	return {
		...spec,
		session: {
			...spec.session,
			model: choice.model,
			...(choice.thinkingLevel ? { thinkingLevel: choice.thinkingLevel } : {}),
		},
	};
}

/**
 * The session shaping that makes a node a read-only inspector of the given coders' worktrees: the four
 * factory read tools (`factory_read`, `factory_list`, `factory_report`, `factory_diff`) and the
 * `<factory-node>` marker the host maps to the worktrees. Merge `tools` into the node's tool allowlist and
 * append `systemPromptSuffix` to its system prompt; the node still has no way to write or run anything.
 */
export function factoryInspector(sources: readonly string[]): {
	tools: string[];
	systemPromptSuffix: string;
} {
	return {
		tools: [...ROLE_TOOLS.inspector],
		systemPromptSuffix: encodeFactoryNode({ role: "inspector", sources: [...sources] }),
	};
}

export const RELEASE_NODE = "release";
export const LAND_NODE = "land";
export const GATE_OUTPUT = "report";
const gateId = (coderId: string) => `gate-${coderId}`;

export function factoryNodeIds(coders: readonly string[]) {
	return { coders: [...coders], gates: coders.map(gateId), release: RELEASE_NODE, land: LAND_NODE };
}

function literalPrefix(glob: string): string {
	const normalized = glob.replace(/\\/g, "/").replace(/^\.\//, "");
	const wildcard = normalized.search(/[*?]/);
	return wildcard < 0 ? normalized : normalized.slice(0, wildcard);
}

/** Conservative: two coders may collide when one's literal glob prefix extends the other's. */
export function mayOverlap(a: readonly string[], b: readonly string[]): boolean {
	if (a.length === 0 || b.length === 0) return true;
	return a.some((left) =>
		b.some((right) => {
			const l = literalPrefix(left);
			const r = literalPrefix(right);
			return l.startsWith(r) || r.startsWith(l);
		}),
	);
}

function node(
	id: string,
	factory: FactoryNode,
	prompt: string,
	task: string,
	rest: Pick<DagNodeSpec, "inputs" | "outputs" | "approval">,
): DagNodeSpec {
	return {
		id,
		task,
		session: {
			tools: [...ROLE_TOOLS[factory.role]],
			systemPrompt: `${prompt}\n\n${encodeFactoryNode(factory)}`,
		},
		...rest,
	};
}

const WORKTREE_RULES =
	"You can only act through the factory_* tools. Paths are relative to your worktree. Finish by calling dag_submit_result as the only tool call in its message.";

/**
 * A pi-dag definition for the factory flow: N parallel coders (each in its own git worktree with owns/avoid
 * globs) -> one gate node per coder (the project's declared gates, run by the host) -> a join node whose
 * output a human must approve -> a land node that can only start after that approval.
 */
export function buildFactoryDefinition(plan: FactoryPlan): DagDefinition {
	const retries = plan.gateRetries ?? DEFAULT_GATE_RETRIES;
	if (!Number.isInteger(retries) || retries < 0 || retries > MAX_GATE_RETRIES)
		throw new Error(`gateRetries must be a whole number from 0 to ${MAX_GATE_RETRIES}`);
	const ids = factoryNodeIds(plan.coders.map((coder) => coder.id));
	if (plan.coders.length === 0) throw new Error("A factory needs at least one coder");
	if (new Set(ids.coders).size !== ids.coders.length) throw new Error("Coder ids must be unique");
	for (const id of ids.coders)
		if (id === RELEASE_NODE || id === LAND_NODE || id.startsWith("gate-"))
			throw new Error(`Coder id ${id} is reserved`);
	for (const coder of plan.coders)
		if (plan.coders.length > 1 && !coder.owns?.length)
			throw new Error(`Coder ${coder.id} needs owns globs when several coders run in parallel`);
	for (const [index, coder] of plan.coders.entries()) {
		for (const other of plan.coders.slice(index + 1))
			if (mayOverlap(coder.owns ?? [], other.owns ?? []))
				throw new Error(
					`Coders ${coder.id} and ${other.id} may touch the same files; give them disjoint owns globs or merge them`,
				);
	}

	const extra = plan.beforeRelease?.({
		coders: ids.coders,
		gates: ids.gates,
		release: RELEASE_NODE,
		gateOutput: GATE_OUTPUT,
	});
	const nodes: DagNodeSpec[] = [];
	const connections: DagConnection[] = [];

	for (const coder of plan.coders) {
		const owns = coder.owns ?? [];
		const avoid = coder.avoid ?? [];
		nodes.push(
			node(
				coder.id,
				{ role: "coder", owns, avoid, retries },
				`You are a coder in a software factory, working alone in your own git worktree. ${WORKTREE_RULES} When your change is complete, call factory_run_gates, fix what fails, and only then submit.${
					retries > 0
						? ` The host runs the project's gates again when you submit: if they fail, your submit is refused with the failing report and you fix forward and submit again (${retries} correction${retries === 1 ? "" : "s"} at most).`
						: ""
				}`,
				[
					coder.task,
					owns.length ? `You own: ${owns.join(", ")}.` : "",
					avoid.length ? `Do not touch: ${avoid.join(", ")}.` : "",
					"Submit output `summary` (text): what you changed and the gate result.",
				]
					.filter(Boolean)
					.join("\n"),
				{ outputs: { summary: { kind: "text" } } },
			),
		);
		const gate = gateId(coder.id);
		nodes.push(
			node(
				gate,
				{ role: "gate", source: coder.id },
				`You run quality gates for ${coder.id}. ${WORKTREE_RULES} The host decides the verdict; you only report it.`,
				`Call factory_run_gates once, then submit output \`${GATE_OUTPUT}\` (text): the verdict and the failing output, if any.`,
				{ inputs: { coder: { kind: "text" } }, outputs: { [GATE_OUTPUT]: { kind: "text" } } },
			),
		);
		connections.push({
			id: `${coder.id}-to-${gate}`,
			kind: "data",
			from: { nodeId: coder.id, output: "summary" },
			to: { nodeId: gate, input: "coder" },
		});
	}

	nodes.push(...(extra?.nodes ?? []));
	connections.push(...(extra?.connections ?? []));

	nodes.push(
		node(
			RELEASE_NODE,
			{ role: "release", sources: ids.coders },
			`You prepare the release summary for a human reviewer. ${WORKTREE_RULES}`,
			`Call factory_report, then submit output \`summary\` (text): per change set the changed files, the diff stat and the gate verdict, exactly as the host reports them.`,
			{
				inputs: {
					...Object.fromEntries(ids.gates.map((gate) => [gate, { kind: "text" as const }])),
					...(extra?.releaseInputs ?? {}),
				},
				outputs: { summary: { kind: "text" } },
				approval: {
					authority: "human",
					question: `Land ${ids.coders.length} change set(s) on ${plan.target}? Review the diffs and gate results first. Approving releases the landing.`,
				},
			},
		),
	);
	for (const gate of ids.gates)
		connections.push({
			id: `${gate}-to-${RELEASE_NODE}`,
			kind: "data",
			from: { nodeId: gate, output: GATE_OUTPUT },
			to: { nodeId: RELEASE_NODE, input: gate },
		});

	nodes.push(
		node(
			LAND_NODE,
			{ role: "land", sources: ids.coders, release: RELEASE_NODE, target: plan.target },
			`You land approved factory work. ${WORKTREE_RULES}`,
			`Call factory_land once, then submit output \`landed\` (text) with what it reports. If it refuses, submit the refusal; never try another way.`,
			{
				inputs: { release: { kind: "text" } },
				outputs: { landed: { kind: "text" } },
			},
		),
	);
	connections.push({
		id: `${RELEASE_NODE}-to-${LAND_NODE}`,
		kind: "data",
		from: { nodeId: RELEASE_NODE, output: "summary" },
		to: { nodeId: LAND_NODE, input: "release" },
	});

	const roleOf = (id: string): TemplateRole | undefined =>
		ids.coders.includes(id)
			? "coder"
			: ids.gates.includes(id)
				? "gate"
				: id === RELEASE_NODE
					? "release"
					: id === LAND_NODE
						? "land"
						: undefined;
	return {
		title: plan.title,
		defaults: { tools: [] },
		maxConcurrent: Math.min(16, plan.maxConcurrent ?? Math.max(2, plan.coders.length)),
		nodes: nodes.map((spec) => {
			const role = roleOf(spec.id);
			return role ? withModel(spec, plan.models?.[role]) : spec;
		}),
		connections,
	};
}
