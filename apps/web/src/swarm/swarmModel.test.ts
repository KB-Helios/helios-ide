import { expect, test } from "bun:test";
import type { SwarmMember, SwarmPost } from "@thinkrail/contracts";
import { diffLineTone, filterPosts, groupMembers, layoutGraph, postsUntil } from "./swarmModel";

const post = (seq: number, from: string, to: string[], text = "x"): SwarmPost => ({
	seq,
	from,
	to,
	kind: "message",
	text,
	at: "",
});

const member = (
	name: string,
	status: SwarmMember["status"],
	phase: SwarmMember["phase"] = "working",
): SwarmMember => ({
	name,
	kind: "worker",
	status,
	phase,
	brief: { task: "", owns: [], avoid: [] },
	readCursor: 0,
	fixRounds: 0,
	createdAt: "",
});

test("graph puts the coordinator in the centre and weights links by post count", () => {
	const { nodes, links } = layoutGraph(
		[post(1, "coordinator", ["a"]), post(2, "a", ["coordinator"]), post(3, "a", ["coordinator"])],
		200,
	);
	expect(nodes.find((n) => n.name === "coordinator")).toMatchObject({ x: 100, y: 100 });
	const back = links.find((l) => l.from.name === "a" && l.to.name === "coordinator");
	expect(back?.count).toBe(2);
	expect(back?.weight).toBe(4);
});

test("replay keeps posts up to a step; null is live", () => {
	const posts = [post(1, "a", ["b"]), post(2, "b", ["a"])];
	expect(postsUntil(posts, 1).map((p) => p.seq)).toEqual([1]);
	expect(postsUntil(posts, null)).toHaveLength(2);
});

test("members group into active, standing by and retired", () => {
	const groups = groupMembers([
		member("a", "active"),
		member("b", "waiting", "gating"),
		member("c", "waiting"),
		member("d", "killed"),
	]);
	expect(groups.active.map((m) => m.name)).toEqual(["a", "b"]);
	expect(groups.standing.map((m) => m.name)).toEqual(["c"]);
	expect(groups.retired.map((m) => m.name)).toEqual(["d"]);
});

test("board filter matches text and a member's own traffic", () => {
	const posts = [post(1, "a", ["b"], "hello"), post(2, "c", ["coordinator"], "bye")];
	expect(filterPosts(posts, "HELLO", null).map((p) => p.seq)).toEqual([1]);
	expect(filterPosts(posts, "", "b").map((p) => p.seq)).toEqual([1]);
});

test("diff lines are toned", () => {
	expect(diffLineTone("+++ b/x")).toBe("meta");
	expect(diffLineTone("+a")).toBe("add");
	expect(diffLineTone("-a")).toBe("remove");
	expect(diffLineTone(" a")).toBe("plain");
});
