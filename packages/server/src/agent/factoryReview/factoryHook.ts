import type { DagConnection, DagNodeSpec } from "pi-dag";
import {
	type BeforeRelease,
	type BeforeReleaseContext,
	type FactoryPlan,
	factoryInspector,
} from "../factory";
import { FINDINGS_PORT, REVIEW_NODE_ID, REVIEWER_SYSTEM_PROMPT } from "./reviewer";
import type { ResolvedRoles, RoleSelection } from "./roles";

type FactoryRoles = ResolvedRoles["roles"];

/** The release node's input that carries the reviewer's findings; it is what holds release behind review. */
export const RELEASE_REVIEW_INPUT = "review";

export interface FactoryReviewOptions {
	/** Resolved roles; the reviewer runs on `roles.reviewer`, a family other than the coder's. */
	roles: Pick<FactoryRoles, "reviewer">;
	nodeId?: string;
	focus?: string;
}

/**
 * The reviewer wired into the factory template's `beforeRelease` hook. It inspects every coder's
 * worktree through the host's read-only factory tools (`factory_diff`, `factory_report`, `factory_read`,
 * `factory_list`), so no diff is copied through a model and it can neither write nor run anything.
 * Each gate report feeds it, so it starts only after all gates; its `findings` feed the release node,
 * and its human approval must be given before those findings are released — release therefore waits
 * for a person to answer the review, and then for the release approval itself.
 */
export function factoryReviewHook(
	options: FactoryReviewOptions,
): (context: BeforeReleaseContext) => BeforeRelease {
	return (context) => {
		const nodeId = options.nodeId ?? REVIEW_NODE_ID;
		const inspector = factoryInspector(context.coders);
		const node: DagNodeSpec = {
			id: nodeId,
			task: [
				`Review the combined change of ${context.coders.length} parallel coder(s): ${context.coders.join(", ")}.`,
				"Use factory_report for the gate verdicts and factory_diff for each change set; open files with factory_read only for context.",
				options.focus ? `Focus: ${options.focus}` : "",
				`Submit exactly one output, \`${FINDINGS_PORT}\`, as {kind:'json'} with this shape:`,
				'{"findings":[{"severity":"critical|high|medium|low|info","file":"path/relative/to/repo","summary":"one concrete sentence"}]}',
				'Submit {"findings":[]} when you found nothing. A person decides on release either way.',
			]
				.filter(Boolean)
				.join("\n"),
			session: {
				model: options.roles.reviewer.model,
				thinkingLevel: options.roles.reviewer.thinkingLevel,
				tools: inspector.tools,
				systemPrompt: `${REVIEWER_SYSTEM_PROMPT}\n\n${inspector.systemPromptSuffix}`,
			},
			inputs: Object.fromEntries(context.gates.map((gate) => [gate, { kind: "text" as const }])),
			outputs: { [FINDINGS_PORT]: { kind: "json" } },
			approval: {
				authority: "human",
				question:
					"The independent reviewer has submitted its findings. Approve only when each finding is answered or accepted; reject with the reason to keep the release blocked.",
			},
		};
		const connections: DagConnection[] = [
			...context.gates.map(
				(gate): DagConnection => ({
					id: `${gate}-to-${nodeId}`,
					kind: "data",
					from: { nodeId: gate, output: context.gateOutput },
					to: { nodeId, input: gate },
				}),
			),
			{
				id: `${nodeId}-to-${context.release}`,
				kind: "data",
				from: { nodeId, output: FINDINGS_PORT },
				to: { nodeId: context.release, input: RELEASE_REVIEW_INPUT },
			},
		];
		return {
			nodes: [node],
			connections,
			releaseInputs: { [RELEASE_REVIEW_INPUT]: { kind: "json" } },
		};
	};
}

/**
 * Template models from resolved roles: coders on the coder model; the mechanical gate, release and land
 * nodes on the scout (the cheapest model of the coder's family). The reviewer is set by `factoryReviewHook`.
 */
export function factoryModels(
	roles: Pick<FactoryRoles, "coder" | "scout">,
): NonNullable<FactoryPlan["models"]> {
	const pick = (role: RoleSelection) => ({
		model: role.model,
		thinkingLevel: role.thinkingLevel,
	});
	return {
		coder: pick(roles.coder),
		gate: pick(roles.scout),
		release: pick(roles.scout),
		land: pick(roles.scout),
	};
}
