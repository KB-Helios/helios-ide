/**
 * A small layered drawing of a DAG: each node sits in the column of its longest dependency chain, and
 * inside a column the nodes are ordered by where their dependencies sit, which keeps most edges from
 * crossing. No library: the shapes are a few dozen nodes, the layout is a pure function of the view the
 * host sent, and the result is plain numbers the pane draws with boxes and curves.
 */
export const GRAPH_NODE_WIDTH = 140;
export const GRAPH_NODE_HEIGHT = 40;
export const GRAPH_GAP_X = 40;
export const GRAPH_GAP_Y = 12;
export const GRAPH_PADDING = 8;

export interface GraphNodeInput {
	id: string;
}

export interface GraphPlacedNode {
	id: string;
	x: number;
	y: number;
	layer: number;
}

export interface GraphEdgePath {
	from: string;
	to: string;
	/** An SVG path from the right edge of `from` to the left edge of `to`. */
	path: string;
}

export interface GraphLayout {
	width: number;
	height: number;
	layers: number;
	nodes: GraphPlacedNode[];
	edges: GraphEdgePath[];
}

/** The column of every node: 0 for a node nothing precedes, else one past its deepest predecessor. */
export function layerOf(
	ids: readonly string[],
	edges: ReadonlyArray<{ from: string; to: string }>,
): Map<string, number> {
	const known = new Set(ids);
	const parents = new Map<string, string[]>();
	for (const edge of edges) {
		if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue;
		const list = parents.get(edge.to) ?? [];
		list.push(edge.from);
		parents.set(edge.to, list);
	}
	const layers = new Map<string, number>();
	const resolve = (id: string, trail: Set<string>): number => {
		const done = layers.get(id);
		if (done !== undefined) return done;
		// A DAG has no cycle; the trail only stops a malformed view from recursing forever.
		if (trail.has(id)) return 0;
		trail.add(id);
		let depth = 0;
		for (const parent of parents.get(id) ?? []) depth = Math.max(depth, resolve(parent, trail) + 1);
		trail.delete(id);
		layers.set(id, depth);
		return depth;
	};
	for (const id of ids) resolve(id, new Set());
	return layers;
}

export function layoutDag(
	nodes: readonly GraphNodeInput[],
	edges: ReadonlyArray<{ from: string; to: string }>,
): GraphLayout {
	const ids = nodes.map((node) => node.id);
	const layers = layerOf(ids, edges);
	const depth = ids.length ? Math.max(...ids.map((id) => layers.get(id) ?? 0)) + 1 : 0;
	const columns: string[][] = Array.from({ length: depth }, () => []);
	for (const id of ids) columns[layers.get(id) ?? 0]?.push(id);

	const parentsOf = (id: string) =>
		edges.filter((edge) => edge.to === id && layers.has(edge.from)).map((edge) => edge.from);
	// Order each column by the average row of its dependencies in the column before it (stable on ties).
	const row = new Map<string, number>();
	columns[0]?.forEach((id, index) => {
		row.set(id, index);
	});
	for (let layer = 1; layer < depth; layer++) {
		const column = columns[layer] ?? [];
		const weight = (id: string, original: number) => {
			const rows = parentsOf(id).flatMap((parent) => {
				const value = row.get(parent);
				return value === undefined ? [] : [value];
			});
			return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : original;
		};
		const ordered = column
			.map((id, original) => ({ id, original, weight: weight(id, original) }))
			.sort((a, b) => a.weight - b.weight || a.original - b.original)
			.map((entry) => entry.id);
		columns[layer] = ordered;
		ordered.forEach((id, index) => {
			row.set(id, index);
		});
	}

	const placed: GraphPlacedNode[] = [];
	const at = new Map<string, GraphPlacedNode>();
	columns.forEach((column, layer) => {
		column.forEach((id, index) => {
			const node = {
				id,
				layer,
				x: GRAPH_PADDING + layer * (GRAPH_NODE_WIDTH + GRAPH_GAP_X),
				y: GRAPH_PADDING + index * (GRAPH_NODE_HEIGHT + GRAPH_GAP_Y),
			};
			placed.push(node);
			at.set(id, node);
		});
	});

	const paths: GraphEdgePath[] = [];
	const seen = new Set<string>();
	for (const edge of edges) {
		const from = at.get(edge.from);
		const to = at.get(edge.to);
		const key = `${edge.from}\u0000${edge.to}`;
		if (!from || !to || seen.has(key) || edge.from === edge.to) continue;
		seen.add(key);
		const x1 = from.x + GRAPH_NODE_WIDTH;
		const y1 = from.y + GRAPH_NODE_HEIGHT / 2;
		const x2 = to.x;
		const y2 = to.y + GRAPH_NODE_HEIGHT / 2;
		const bend = Math.max(GRAPH_GAP_X / 2, (x2 - x1) / 2);
		paths.push({
			from: edge.from,
			to: edge.to,
			path: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
		});
	}

	const tallest = Math.max(0, ...columns.map((column) => column.length));
	return {
		width: depth ? GRAPH_PADDING * 2 + depth * GRAPH_NODE_WIDTH + (depth - 1) * GRAPH_GAP_X : 0,
		height: tallest
			? GRAPH_PADDING * 2 + tallest * GRAPH_NODE_HEIGHT + (tallest - 1) * GRAPH_GAP_Y
			: 0,
		layers: depth,
		nodes: placed,
		edges: paths,
	};
}
