import type { DagNodeStatus, DagView } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { useMemo } from "react";
import { statusLabel } from "./factoryLabels";
import { needsAttention } from "./factoryModel";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH, type GraphLayout, layoutDag } from "./graphLayout";

/** Colour is a second channel: every box also carries the status word, so state never rests on it. */
function boxClass(status: DagNodeStatus): string {
	if (needsAttention(status)) return "border-feedback-warning";
	if (status === "completed") return "border-feedback-success-muted";
	if (status === "cancelled") return "border-feedback-error";
	if (status === "running") return "border-text-default";
	return "border-border-default";
}

/**
 * The DAG as columns of steps joined by their dependency edges (`graphLayout.ts` lays it out). It is a
 * picture of what the Steps list below already says, so it is hidden from assistive technology except for
 * one summary; the list stays the accessible, actionable view.
 */
export function FactoryGraph({ dag }: { dag: Pick<DagView, "nodes" | "edges"> }) {
	const t = useT();
	const layout: GraphLayout = useMemo(
		() => layoutDag(dag.nodes, dag.edges),
		[dag.nodes, dag.edges],
	);
	const status = new Map(dag.nodes.map((node) => [node.id, node.status]));
	if (layout.nodes.length === 0) return null;
	return (
		<details open className="px-12" data-testid="factory-graph">
			<summary className="cursor-pointer py-8 tr-text-metadata text-text-muted focus-visible:focus-ring-inset">
				{t("factory.graph.heading")}
			</summary>
			<div
				className="max-h-[40vh] overflow-auto pb-8"
				role="img"
				aria-label={t("factory.graph.summary", {
					steps: layout.nodes.length,
					columns: layout.layers,
				})}
			>
				<div className="relative" style={{ width: layout.width, height: layout.height }}>
					<svg
						className="absolute inset-0 text-border-default"
						width={layout.width}
						height={layout.height}
						aria-hidden
					>
						{layout.edges.map((edge) => (
							<path
								key={`${edge.from}->${edge.to}`}
								d={edge.path}
								fill="none"
								stroke="currentColor"
								strokeWidth={1.5}
							/>
						))}
					</svg>
					{layout.nodes.map((node) => {
						const state = status.get(node.id) ?? "pending";
						return (
							<div
								key={node.id}
								className={cn(
									"absolute flex flex-col justify-center overflow-hidden rounded-sm border bg-container-elevated-bg px-8",
									boxClass(state),
								)}
								style={{
									left: node.x,
									top: node.y,
									width: GRAPH_NODE_WIDTH,
									height: GRAPH_NODE_HEIGHT,
								}}
								data-testid="factory-graph-node"
								data-status={state}
								title={`${node.id}: ${statusLabel(t, state)}`}
							>
								<span className="truncate tr-text-metadata text-text-default">{node.id}</span>
								<span className="truncate tr-text-metadata text-text-muted">
									{statusLabel(t, state)}
								</span>
							</div>
						);
					})}
				</div>
			</div>
		</details>
	);
}
