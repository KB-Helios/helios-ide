import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BoundNode, FactoryRun, WorktreeMeta } from "./run";
import { ROLE_TOOLS } from "./spec";

export function toolResult<T>(value: T): { content: { type: "text"; text: string }[]; details: T } {
	return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

/** The factory node behind this session, or a refusal: the extension is inert for every other child. */
export function boundFor(run: FactoryRun, ctx: ExtensionContext, tool: string): BoundNode {
	const bound = run.boundNode(ctx.sessionManager.getSessionId());
	if (!bound) throw new Error(`${tool} is only available to factory nodes`);
	if (!ROLE_TOOLS[bound.node.role].includes(tool))
		throw new Error(`${tool} is not available to a ${bound.node.role} node`);
	return bound;
}

/** The node ids whose worktrees this node may look at. */
export function sourcesOf(bound: BoundNode): string[] {
	const { node } = bound;
	if (node.role === "coder") return [bound.nodeId];
	if (node.role === "gate") return [node.source];
	return node.sources;
}

/** The integration node whose combined-gate verdict this node reports: itself, or the one it names. */
export function integrationOf(bound: BoundNode): string | undefined {
	const { node } = bound;
	if (node.role === "integration") return bound.nodeId;
	return node.role === "coder" || node.role === "gate" ? undefined : node.integration;
}

/** The one worktree a file or gate tool acts on: the only source, or the one the node names. */
export function sourceWorktree(
	run: FactoryRun,
	bound: BoundNode,
	requested: string | undefined,
): WorktreeMeta {
	const sources = sourcesOf(bound);
	const nodeId = requested ?? (sources.length === 1 ? sources[0] : undefined);
	if (!nodeId) throw new Error(`Name the source node: one of ${sources.join(", ")}`);
	if (!sources.includes(nodeId))
		throw new Error(`${nodeId} is not a source of this node (${sources.join(", ")})`);
	return run.activeWorktree(nodeId);
}
