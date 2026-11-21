import type {
	DagGateView,
	DagHistoryItem,
	DagNodeStatus,
	DagQueueView,
	DagReviewSeverity,
	DagReviewView,
	DagStartRequest,
	DagUsageView,
	DagView,
	DagWireCommand,
	FactoryModelChoice,
	FactoryRoleName,
	FactoryRolesView,
} from "@thinkrail/contracts";

/** Statuses that need a person before the DAG can move on; shown first and never hidden. */
const ATTENTION: ReadonlySet<DagNodeStatus> = new Set([
	"waiting-input",
	"waiting-approval",
	"needs-attention",
	"uncertain",
	"stale",
]);

export function needsAttention(status: DagNodeStatus): boolean {
	return ATTENTION.has(status);
}

/** Node ids this node waits for, in definition order, without duplicates. */
export function dependsOn(dag: Pick<DagView, "edges">, nodeId: string): string[] {
	return [...new Set(dag.edges.filter((edge) => edge.to === nodeId).map((edge) => edge.from))];
}

/** Nodes needing attention first, then the rest in their original order. */
export function orderNodes<T extends { status: DagNodeStatus }>(nodes: readonly T[]): T[] {
	return [
		...nodes.filter((node) => needsAttention(node.status)),
		...nodes.filter((node) => !needsAttention(node.status)),
	];
}

/** Total gates waiting across the workspace's DAGs. */
export function pendingTotal(items: readonly { pendingGates: number }[]): number {
	return items.reduce((sum, item) => sum + item.pendingGates, 0);
}

/** Severities from most to least serious: the order findings are listed in. */
export const SEVERITY_ORDER: readonly DagReviewSeverity[] = [
	"critical",
	"high",
	"medium",
	"low",
	"info",
];

export function bySeverity<T extends { severity: DagReviewSeverity }>(findings: readonly T[]): T[] {
	return [...findings].sort(
		(a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
	);
}

/** What the DAG's nodes used in total; `null` while no node has run. */
export function totalUsage(
	nodes: readonly { usage?: DagUsageView }[],
): Pick<DagUsageView, "input" | "output" | "cost"> | null {
	const ran = nodes.flatMap((node) => (node.usage ? [node.usage] : []));
	if (ran.length === 0) return null;
	return {
		input: ran.reduce((sum, usage) => sum + usage.input, 0),
		output: ran.reduce((sum, usage) => sum + usage.output, 0),
		cost: ran.reduce((sum, usage) => sum + usage.cost, 0),
	};
}

export interface QueueLine {
	running: number;
	queued: number;
	limit: number;
	/** Every slot is taken and work waits for one. */
	saturated: boolean;
	/** The machine-wide cap across workspaces, when the host reports it and it holds work back. */
	global?: { running: number; queued: number; limit: number };
}

/** What the pane shows of the workspace's worker slots; `null` while nothing runs or waits. */
export function queueLine(queue: DagQueueView | null): QueueLine | null {
	if (!queue || queue.running + queue.queued === 0) return null;
	return {
		running: queue.running,
		queued: queue.queued,
		limit: queue.limit,
		saturated: queue.queued > 0 && queue.running >= queue.limit,
		// Shown only when the machine-wide cap is what is full, so the common case stays one line.
		...(queue.global && queue.global.running >= queue.global.limit && queue.global.queued > 0
			? { global: queue.global }
			: {}),
	};
}

export type NodeAction = "continue" | "retry" | "cancel";

/**
 * The controls a node offers, from what pi-dag allows: an interrupted node can continue its own attempt, a
 * node that stopped without a result (or went stale) can start a new attempt, and work that is queued,
 * running or held can be cancelled. A node that never ran has no attempt, so nothing targets it.
 */
export function nodeActions(
	node: Pick<DagView["nodes"][number], "status" | "attempt" | "activation">,
): NodeAction[] {
	if (node.attempt === undefined) return [];
	const actions: NodeAction[] = [];
	if (node.status === "interrupted" && node.activation !== undefined) actions.push("continue");
	if (["interrupted", "cancelled", "needs-attention", "stale"].includes(node.status))
		actions.push("retry");
	if (["queued", "running", "interrupted"].includes(node.status)) actions.push("cancel");
	return actions;
}

/** The wire command of a node action; `null` when the node lacks the attempt it needs. */
export function nodeCommand(
	action: NodeAction,
	node: Pick<DagView["nodes"][number], "id" | "attempt" | "activation">,
): DagWireCommand | null {
	if (node.attempt === undefined) return null;
	switch (action) {
		case "retry":
			return { kind: "retry", nodeId: node.id, attempt: node.attempt };
		case "cancel":
			return { kind: "cancel", nodeId: node.id };
		case "continue":
			return node.activation === undefined
				? null
				: { kind: "continue", nodeId: node.id, attempt: node.attempt, activation: node.activation };
	}
}

/** DAG-wide controls: interrupt only makes sense while it runs, cancel while it is active. */
export function dagActions(
	dag: Pick<DagView, "mode" | "lifecycle">,
): Array<"interrupt" | "cancel"> {
	if (dag.lifecycle !== "active") return [];
	return dag.mode === "running" ? ["interrupt", "cancel"] : ["cancel"];
}

/** A history row's target as one short label; empty for events that have none. */
export function historyTarget(item: Pick<DagHistoryItem, "target">): string {
	return item.target
		? `${item.target.nodeId} #${item.target.attempt}.${item.target.activation}`
		: "";
}

export type RunMode = "plan" | "single";

/** The start form's state: the task, who splits it, and a model pick per role (`""` is the host's default). */
export interface StartForm {
	task: string;
	mode: RunMode;
	picks: Partial<Record<FactoryRoleName, string>>;
	allowSameFamily: boolean;
}

export const START_TASK_MAX = 8000;
export const ROLE_ORDER: readonly FactoryRoleName[] = ["planner", "coder", "reviewer", "scout"];

export const modelKey = (model: FactoryModelChoice): string => `${model.provider}/${model.id}`;

function familyOfKey(view: FactoryRolesView, key: string): string | undefined {
	return view.models.find((model) => modelKey(model) === key)?.family;
}

/** The model a role would run on: the person's pick, else the host's default. */
export function effectiveKey(
	view: FactoryRolesView,
	form: Pick<StartForm, "picks">,
	role: FactoryRoleName,
): string {
	return form.picks[role] || modelKey(view.defaults[role]);
}

/**
 * Whether the reviewer would share the coder's vendor family: the host refuses that unless the person
 * explicitly allows it, so the form asks for that decision instead of failing after the click.
 */
export function reviewerSharesFamily(
	view: FactoryRolesView,
	form: Pick<StartForm, "picks">,
): boolean {
	if (!form.picks.reviewer && !form.picks.coder && view.sameFamilyOnly) return true;
	const coder = familyOfKey(view, effectiveKey(view, form, "coder"));
	// An automatic reviewer is resolved by the host relative to the effective coder: it shares the coder's
	// family only when no model of another family exists.
	if (!form.picks.reviewer)
		return coder !== undefined && !view.models.some((model) => model.family !== coder);
	const reviewer = familyOfKey(view, effectiveKey(view, form, "reviewer"));
	return coder !== undefined && coder === reviewer;
}

/** Why the form cannot be sent yet, or `null` when it can. */
export function startBlocker(
	view: FactoryRolesView,
	form: StartForm,
): "task" | "same-family" | null {
	const task = form.task.trim();
	if (task.length === 0 || task.length > START_TASK_MAX) return "task";
	if (reviewerSharesFamily(view, form) && !form.allowSameFamily) return "same-family";
	return null;
}

/**
 * The wire request for the form. A role left on the default sends nothing, so the host's choice stays
 * the host's; a same-family reviewer is sent only when the person switched it on (and it applies).
 */
export function startRequest(
	view: FactoryRolesView,
	form: StartForm,
): Omit<DagStartRequest, "workspaceId" | "commandId"> | null {
	if (startBlocker(view, form) === "task") return null;
	const roles: Partial<Record<FactoryRoleName, FactoryModelChoice>> = {};
	for (const role of ROLE_ORDER) {
		const key = form.picks[role];
		const model = key ? view.models.find((candidate) => modelKey(candidate) === key) : undefined;
		if (model) roles[role] = { provider: model.provider, id: model.id };
	}
	const task = form.task.trim();
	return {
		task,
		...(form.mode === "single" ? { coders: [{ id: "coder", task }] } : {}),
		...(Object.keys(roles).length ? { roles } : {}),
		...(form.allowSameFamily && reviewerSharesFamily(view, form)
			? { allowSameFamilyReviewer: true }
			: {}),
	};
}

/** A planning DAG whose planner finished (its approval is checked again on the host). */
export function planReady(dag: Pick<DagView, "nodes">): boolean {
	return dag.nodes.some((node) => node.planner === true && node.status === "completed");
}

/**
 * The reviewer findings a gate's decision rests on: the gate's own node when it is the reviewer, else a
 * reviewer node with an edge straight into it (the factory's release node takes the review's findings as
 * an input). A release card then shows the findings its question asks the person to have answered.
 */
export function reviewForGate(
	gate: Pick<DagGateView, "target">,
	dag: Pick<DagView, "edges">,
	reviews: Readonly<Record<string, DagReviewView>>,
): DagReviewView | undefined {
	const own = reviews[gate.target.nodeId];
	if (own) return own;
	for (const edge of dag.edges) {
		if (edge.to !== gate.target.nodeId) continue;
		const upstream = reviews[edge.from];
		if (upstream) return upstream;
	}
	return undefined;
}
