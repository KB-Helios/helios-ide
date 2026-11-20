import type {
	DagNodeStatus,
	DagQueueView,
	DagReviewSeverity,
	DagUsageView,
	DagView,
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
