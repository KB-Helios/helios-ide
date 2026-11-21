export const COORDINATOR = "coordinator";
export const MONITOR = "monitor";
export const ALL = "all";

export type MemberKind = "worker" | "verifier" | "reviewer" | "scout" | "custom" | "a2a";
export type MemberStatus = "active" | "waiting" | "paused" | "killed";
export type MemberPhase = "working" | "gating" | "reviewing" | "needs-fixes" | "done";
export type PostKind = "brief" | "message" | "report" | "gate" | "review" | "system";

export interface MemberBrief {
	task: string;
	owns: string[];
	avoid: string[];
	done?: string;
}

export interface GateResult {
	command: string;
	ok: boolean;
	exitCode: number | null;
	durationMs: number;
	outputTail: string;
}

export interface Member {
	name: string;
	group?: string;
	kind: MemberKind;
	definition?: string;
	status: MemberStatus;
	phase: MemberPhase;
	brief: MemberBrief;
	model?: string;
	childSessionId?: string;
	a2a?: { agent: string; taskId?: string; contextId?: string };
	worktree?: { path: string; branch: string; base: string };
	activity?: string;
	lastPost?: number;
	readCursor: number;
	gates?: GateResult[];
	ownershipViolations?: string[];
	review?: { verdict: "approve" | "changes"; summary: string; reviewerSessionId?: string };
	changedFiles?: string[];
	landed?: boolean;
	doneClaim?: string;
	fixRounds: number;
	error?: string;
	/** Loaded from a stored board after a host restart: no live session until it is resumed. */
	restored?: boolean;
	/** Restored, but its worktree directory no longer exists. */
	worktreeMissing?: boolean;
	createdAt: string;
}

export interface Post {
	seq: number;
	from: string;
	to: string[];
	kind: PostKind;
	text: string;
	at: string;
}

export interface GraphEdge {
	from: string;
	to: string;
	count: number;
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MENTION = /(^|[^\w@])@([a-z][a-z0-9-]{0,39})(?![a-z0-9-])/gi;
const RESERVED: ReadonlySet<string> = new Set([ALL, COORDINATOR, MONITOR, "gates", "system"]);

export function assertMemberName(name: string): void {
	if (!NAME.test(name) || RESERVED.has(name))
		throw new Error(
			`Invalid member name "${name}": use lowercase letters, digits and dashes (e.g. parser, api-tests), and not "${ALL}", "${COORDINATOR}" or "${MONITOR}".`,
		);
}

export function parseMentions(text: string): string[] {
	const names = new Set<string>();
	for (const match of text.matchAll(MENTION)) names.add((match[2] ?? "").toLowerCase());
	return [...names];
}

/** The ordered, append-only message board and member roster of one swarm. */
export class Board {
	readonly members = new Map<string, Member>();
	readonly posts: Post[] = [];
	coordinatorCursor = 0;

	add(member: Member): void {
		assertMemberName(member.name);
		if (this.members.has(member.name))
			throw new Error(
				`A member named @${member.name} already exists (killed members keep their name).`,
			);
		if (member.group && RESERVED.has(member.group))
			throw new Error(`"${member.group}" is reserved and cannot name a group.`);
		if (member.group && this.members.has(member.group))
			throw new Error(`@${member.group} is a member, so it cannot also name a group.`);
		if ([...this.members.values()].some((m) => m.group === member.name))
			throw new Error(`@${member.name} already names a group.`);
		this.members.set(member.name, member);
	}

	get(name: string): Member | undefined {
		return this.members.get(name);
	}

	require(name: string): Member {
		const member = this.members.get(name.replace(/^@/, ""));
		if (!member)
			throw new Error(
				`No member @${name}. Members: ${[...this.members.keys()].join(", ") || "none"}.`,
			);
		return member;
	}

	/** Expands @name, @group and @all into live recipients other than the sender. */
	resolve(from: string, names: readonly string[]): string[] {
		const out = new Set<string>();
		for (const raw of names) {
			const name = raw.replace(/^@/, "").toLowerCase();
			if (name === ALL) {
				out.add(COORDINATOR);
				for (const m of this.members.values()) if (m.status !== "killed") out.add(m.name);
			} else if (name === COORDINATOR) out.add(COORDINATOR);
			else if (this.members.get(name)?.status !== undefined) {
				if (this.members.get(name)?.status !== "killed") out.add(name);
			} else
				for (const m of this.members.values())
					if (m.group === name && m.status !== "killed") out.add(m.name);
		}
		out.delete(from);
		return [...out];
	}

	/** Agent-authored posts address by @mention; gate and system notices only reach `explicit`. */
	post(from: string, text: string, kind: PostKind, explicit: readonly string[] = []): Post {
		const notice = kind === "gate" || kind === "system";
		const to = this.resolve(from, [...explicit, ...(notice ? [] : parseMentions(text))]);
		const post: Post = {
			seq: this.posts.length + 1,
			from,
			to,
			kind,
			text,
			at: new Date().toISOString(),
		};
		this.posts.push(post);
		const sender = this.members.get(from);
		if (sender) sender.lastPost = post.seq;
		return post;
	}

	/** Posts addressed to `name` after its read cursor; advances the cursor. */
	takeUnread(name: string): Post[] {
		const cursor =
			name === COORDINATOR ? this.coordinatorCursor : (this.members.get(name)?.readCursor ?? 0);
		const unread = this.posts.filter((p) => p.seq > cursor && p.to.includes(name));
		const last = this.posts.length;
		if (name === COORDINATOR) this.coordinatorCursor = last;
		else {
			const member = this.members.get(name);
			if (member) member.readCursor = last;
		}
		return unread;
	}

	read(options: { since?: number; member?: string; limit?: number } = {}): Post[] {
		const member = options.member?.replace(/^@/, "");
		const filtered = this.posts.filter(
			(p) =>
				p.seq > (options.since ?? 0) && (!member || p.from === member || p.to.includes(member)),
		);
		return filtered.slice(-(options.limit ?? 50));
	}

	graph(): GraphEdge[] {
		const counts = new Map<string, number>();
		for (const post of this.posts)
			for (const to of post.to) {
				const key = `${post.from}\u0000${to}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
		return [...counts].map(([key, count]) => {
			const [from = "", to = ""] = key.split("\u0000");
			return { from, to, count };
		});
	}
}

export function formatPost(post: Post): string {
	const to = post.to.length ? ` → ${post.to.map((n) => `@${n}`).join(" ")}` : "";
	return `#${post.seq} @${post.from}${to} [${post.kind}]\n${post.text}`;
}

export function formatPosts(posts: readonly Post[]): string {
	return posts.length ? posts.map(formatPost).join("\n\n") : "(no posts)";
}
