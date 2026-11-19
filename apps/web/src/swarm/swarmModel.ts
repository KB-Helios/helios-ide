import type { SwarmMember, SwarmPost, SwarmSnapshot } from "@thinkrail/contracts";

export const COORDINATOR = "coordinator";

export interface GraphNode {
	name: string;
	x: number;
	y: number;
}

export interface GraphLink {
	from: GraphNode;
	to: GraphNode;
	count: number;
	weight: number;
}

/** Coordinator in the centre, every other sender or recipient on a circle around it. */
export function layoutGraph(
	posts: readonly SwarmPost[],
	size: number,
): { nodes: GraphNode[]; links: GraphLink[] } {
	const counts = new Map<string, number>();
	const names = new Set<string>([COORDINATOR]);
	for (const post of posts)
		for (const to of post.to) {
			names.add(post.from);
			names.add(to);
			const key = `${post.from}\u0000${to}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	const centre = size / 2;
	const radius = size / 2 - 40;
	const ring = [...names].filter((name) => name !== COORDINATOR).sort();
	const nodes = new Map<string, GraphNode>([
		[COORDINATOR, { name: COORDINATOR, x: centre, y: centre }],
	]);
	ring.forEach((name, index) => {
		const angle = (2 * Math.PI * index) / Math.max(ring.length, 1) - Math.PI / 2;
		nodes.set(name, {
			name,
			x: Math.round(centre + radius * Math.cos(angle)),
			y: Math.round(centre + radius * Math.sin(angle)),
		});
	});
	const max = Math.max(1, ...counts.values());
	const links: GraphLink[] = [];
	for (const [key, count] of counts) {
		const [from = "", to = ""] = key.split("\u0000");
		const a = nodes.get(from);
		const b = nodes.get(to);
		if (a && b) links.push({ from: a, to: b, count, weight: 1 + Math.round((3 * count) / max) });
	}
	return { nodes: [...nodes.values()], links };
}

/** Posts up to `step` (1-based post number), for graph replay; `null` means live. */
export function postsUntil(posts: readonly SwarmPost[], step: number | null): SwarmPost[] {
	return step === null ? [...posts] : posts.filter((post) => post.seq <= step);
}

export type MemberGroup = "active" | "standing" | "retired";

export function groupMembers(members: readonly SwarmMember[]): Record<MemberGroup, SwarmMember[]> {
	const groups: Record<MemberGroup, SwarmMember[]> = { active: [], standing: [], retired: [] };
	for (const member of members) {
		if (member.status === "killed") groups.retired.push(member);
		else if (
			member.status === "active" ||
			member.phase === "gating" ||
			member.phase === "reviewing"
		)
			groups.active.push(member);
		else groups.standing.push(member);
	}
	return groups;
}

export function filterPosts(
	posts: readonly SwarmPost[],
	query: string,
	member: string | null,
): SwarmPost[] {
	const needle = query.trim().toLowerCase();
	return posts.filter(
		(post) =>
			(!member || post.from === member || post.to.includes(member)) &&
			(!needle || post.text.toLowerCase().includes(needle) || post.from.includes(needle)),
	);
}

export function liveCount(snapshot: SwarmSnapshot): number {
	return snapshot.members.filter((m) => m.status === "active").length;
}

export function diffLineTone(line: string): "add" | "remove" | "meta" | "plain" {
	if (
		line.startsWith("+++") ||
		line.startsWith("---") ||
		line.startsWith("diff ") ||
		line.startsWith("@@")
	)
		return "meta";
	if (line.startsWith("+")) return "add";
	if (line.startsWith("-")) return "remove";
	return "plain";
}

export function diffLines(
	patch: string,
): Array<{ key: string; tone: ReturnType<typeof diffLineTone>; text: string }> {
	return patch
		.split("\n")
		.map((text, line) => ({ key: `L${line}`, tone: diffLineTone(text), text }));
}
