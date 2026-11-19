import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatPosts } from "./board.ts";
import { MEMBER_TOOLS } from "./prompts.ts";
import { type Membership, membershipOf } from "./registry.ts";

function require(ctx: ExtensionContext): Membership {
	const membership = membershipOf(ctx.sessionManager.getSessionId());
	if (!membership) throw new Error("This session is no longer a swarm member.");
	return membership;
}

/** Curated child extension: gives swarm members their board tools. Inert in any other child. */
export const swarmMemberExtension: ExtensionFactory = (pi: ExtensionAPI) => {
	let registered = false;
	pi.on("before_agent_start", (_event, ctx) => {
		if (registered || !membershipOf(ctx.sessionManager.getSessionId())) return;
		registered = true;
		pi.registerTool({
			name: "swarm_post",
			label: "Swarm post",
			description:
				"Post to the swarm's shared board mid-task. Mention @name, @group or @all to address and wake members; with no mention the post goes to @coordinator.",
			parameters: Type.Object({
				text: Type.String(),
				to: Type.Optional(
					Type.Array(Type.String(), { description: "Extra recipients (names without @)" }),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const { swarm, member } = require(ctx);
				const post = swarm.post(member, params.text, "message", params.to ?? []);
				return {
					content: [
						{
							type: "text",
							text: `Posted #${post.seq} to ${post.to.map((n) => `@${n}`).join(" ")}.`,
						},
					],
					details: { post },
				};
			},
		});
		pi.registerTool({
			name: "swarm_board",
			label: "Swarm board",
			description: "Read the swarm's shared board: briefs, questions, reports and gate results.",
			parameters: Type.Object({
				since: Type.Optional(Type.Number({ description: "Only posts after this number" })),
				member: Type.Optional(Type.String({ description: "Only posts from or to this member" })),
				limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const { swarm } = require(ctx);
				const posts = swarm.board.read(params);
				return { content: [{ type: "text", text: formatPosts(posts) }], details: { posts } };
			},
		});
		pi.registerTool({
			name: "swarm_done",
			label: "Swarm done",
			description:
				"Declare your brief complete and verified. When you end your turn the swarm checks file ownership, runs the quality gates and a read-only review; failures come back to you on the board.",
			parameters: Type.Object({
				summary: Type.String({ description: "What changed and how you verified it" }),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const { swarm, member } = require(ctx);
				return {
					content: [{ type: "text", text: swarm.claimDone(member, params.summary) }],
					details: {},
				};
			},
		});
		const active = new Set(pi.getActiveTools());
		if (MEMBER_TOOLS.some((tool) => !active.has(tool)))
			pi.setActiveTools([...active, ...MEMBER_TOOLS]);
	});
};
