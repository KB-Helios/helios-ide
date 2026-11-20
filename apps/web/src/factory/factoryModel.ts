import type {
	DagHistoryItem,
	DagNodeStatus,
	DagQueueView,
	DagReviewSeverity,
	DagUsageView,
	DagView,
	DagWireCommand,
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
}

/** What the pane shows of the workspace's worker slots; `null` while nothing runs or waits. */
export function queueLine(queue: DagQueueView | null): QueueLine | null {
	if (!queue || queue.running + queue.queued === 0) return null;
	return {
		running: queue.running,
		queued: queue.queued,
		limit: queue.limit,
		saturated: queue.queued > 0 && queue.running >= queue.limit,
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
