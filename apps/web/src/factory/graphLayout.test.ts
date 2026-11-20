import { expect, test } from "bun:test";
import {
	GRAPH_GAP_X,
	GRAPH_NODE_HEIGHT,
	GRAPH_NODE_WIDTH,
	layerOf,
	layoutDag,
} from "./graphLayout";

const ids = (...names: string[]) => names.map((id) => ({ id }));

test("a node sits one column right of its deepest dependency", () => {
	const layers = layerOf(
		["a", "b", "c", "d"],
		[
			{ from: "a", to: "b" },
			{ from: "b", to: "c" },
			{ from: "a", to: "c" },
		],
	);
	expect([...layers]).toEqual([
		["a", 0],
		["b", 1],
		["c", 2],
		["d", 0],
	]);
});

test("the factory shape lays out as columns of coders, gates, review, release and land", () => {
	const layout = layoutDag(ids("api", "gate-api", "web", "gate-web", "review", "release", "land"), [
		{ from: "api", to: "gate-api" },
		{ from: "web", to: "gate-web" },
		{ from: "gate-api", to: "review" },
		{ from: "gate-web", to: "review" },
		{ from: "gate-api", to: "release" },
		{ from: "gate-web", to: "release" },
		{ from: "review", to: "release" },
		{ from: "release", to: "land" },
	]);
	const layer = Object.fromEntries(layout.nodes.map((node) => [node.id, node.layer]));
	expect(layer).toEqual({
		api: 0,
		web: 0,
		"gate-api": 1,
		"gate-web": 1,
		review: 2,
		release: 3,
		land: 4,
	});
	expect(layout.layers).toBe(5);
	expect(layout.width).toBe(16 + 5 * GRAPH_NODE_WIDTH + 4 * GRAPH_GAP_X);
	expect(layout.height).toBe(16 + 2 * GRAPH_NODE_HEIGHT + 12);
	expect(layout.edges).toHaveLength(8);
	// Edges leave the right edge of the source and enter the left edge of the target.
	const gate = layout.nodes.find((node) => node.id === "gate-api");
	const edge = layout.edges.find((candidate) => candidate.from === "api");
	expect(edge?.path.startsWith(`M ${8 + GRAPH_NODE_WIDTH} ${8 + GRAPH_NODE_HEIGHT / 2} C`)).toBe(
		true,
	);
	expect(edge?.path.endsWith(`${gate?.x} ${(gate?.y ?? 0) + GRAPH_NODE_HEIGHT / 2}`)).toBe(true);
});

test("a column follows the order of its dependencies instead of the definition order", () => {
	const layout = layoutDag(ids("a", "b", "x", "y"), [
		{ from: "a", to: "y" },
		{ from: "b", to: "x" },
	]);
	const row = (id: string) => layout.nodes.find((node) => node.id === id)?.y;
	// y depends on a (row 0), x on b (row 1): y goes above x although x is defined first.
	expect((row("y") ?? 0) < (row("x") ?? 0)).toBe(true);
});

test("unknown, repeated and self edges are ignored and a malformed cycle cannot hang the layout", () => {
	const layout = layoutDag(ids("a", "b"), [
		{ from: "a", to: "b" },
		{ from: "a", to: "b" },
		{ from: "a", to: "ghost" },
		{ from: "b", to: "b" },
	]);
	expect(layout.edges).toHaveLength(1);
	const cyclic = layoutDag(ids("a", "b"), [
		{ from: "a", to: "b" },
		{ from: "b", to: "a" },
	]);
	expect(cyclic.nodes).toHaveLength(2);
	expect(layoutDag([], [])).toEqual({ width: 0, height: 0, layers: 0, nodes: [], edges: [] });
});

test("the largest DAG pi-dag admits lays out at once", () => {
	const names = Array.from({ length: 128 }, (_, index) => `n${index}`);
	const edges = names.slice(1).map((to, index) => ({ from: `n${Math.floor(index / 2)}`, to }));
	const started = performance.now();
	const layout = layoutDag(ids(...names), edges);
	expect(performance.now() - started).toBeLessThan(500);
	expect(layout.nodes).toHaveLength(128);
	expect(layout.edges).toHaveLength(127);
});
