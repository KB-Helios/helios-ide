import type { Member } from "./board.ts";

export const MEMBER_TOOLS = ["swarm_post", "swarm_board", "swarm_done"] as const;

export function memberBridge(options: {
	title: string;
	member: Member;
	roster: readonly Member[];
	gates: readonly string[];
	review: boolean;
}): string {
	const { member } = options;
	const others = options.roster
		.filter((m) => m.name !== member.name && m.status !== "killed")
		.map((m) => `@${m.name}${m.group ? ` (group @${m.group})` : ""} — ${m.kind}`)
		.join("\n");
	const where = member.worktree
		? `You work in your own git worktree at ${member.worktree.path} on branch ${member.worktree.branch}. Other members cannot see your edits until the coordinator lands them, so share interfaces on the board rather than expecting them in files.`
		: "You share the coordinator's working tree with other members: touch only the files you own.";
	const quality =
		member.kind === "worker" || member.kind === "custom"
			? `When you call swarm_done, the swarm checks that you only changed files you own, runs ${
					options.gates.length
						? options.gates.map((g) => `\`${g}\``).join(", ")
						: "no project gates"
				}${options.review ? ", then a separate read-only reviewer reviews your diff" : ""}. Failures come back to you on the board: fix them and call swarm_done again.`
			: "";
	return `## Swarm membership

You are @${member.name}, a ${member.kind} in the swarm "${options.title}", coordinated by @coordinator.
Other members:
${others || "(none yet)"}

### Your brief
${member.brief.task}
${member.brief.owns.length ? `\nYou own (may change): ${member.brief.owns.join(", ")}` : ""}${
	member.brief.avoid.length ? `\nYou must not touch: ${member.brief.avoid.join(", ")}` : ""
}${member.brief.done ? `\nDone when: ${member.brief.done}` : ""}

### Board protocol
- Your final message of every turn is posted to the shared board. Address members with @name, a group with @group, everyone with @all; a final message that mentions nobody goes to @coordinator.
- Use swarm_post to post mid-task (a question, an interface you expose, a heads-up) and swarm_board to read the board.
- Ending your turn puts you to sleep at no cost; you wake automatically with the new posts when someone mentions you. Do not poll or sleep.
- Never message members privately or edit files another member owns; ask on the board instead.

### Workspace and finishing
${where}
Never commit, stash, reset or push: the coordinator lands your changes.
Follow the repository's AGENTS.md and the SPEC.md of every module you change.
When your task is complete and verified, call swarm_done with a short summary and end your turn. ${quality}`;
}

export function wakePrompt(text: string): string {
	return `New posts for you on the swarm board:\n\n${text}\n\nAct on them. Your final message is posted to the board.`;
}

export const REVIEW_VERDICT = /VERDICT:\s*(APPROVE|CHANGES_REQUESTED)/i;

export function reviewTask(options: { member: Member; stat: string; patch: string }): string {
	const patch =
		options.patch.length > 80_000
			? `${options.patch.slice(0, 80_000)}\n…[diff truncated]`
			: options.patch;
	return `Review the change made by swarm member @${options.member.name} in this working copy.

Its brief:
${options.member.brief.task}
${options.member.brief.done ? `Done when: ${options.member.brief.done}` : ""}

Diff stat:
${options.stat}

Diff (against its base commit):
\`\`\`diff
${patch}
\`\`\`

You are read-only. Report only material problems this diff introduces: bugs, broken contracts, missing
tests for new behavior, convention or SPEC violations. End with exactly one line:
VERDICT: APPROVE  or  VERDICT: CHANGES_REQUESTED`;
}

export function coordinatorPrompt(task: string): string {
	return `/swarm — you are now the coordinator of a swarm for this task:

${task}

Run it with the swarm_* tools. You coordinate; you do not do the technical work yourself.
1. Understand the repository just enough to split the work: read AGENTS.md, and use the spec tools
   (spec_search / spec_graph) when present to find the modules and contracts involved.
2. Split contract-first. Where pieces share an interface (types, a wire contract, a schema), either
   pin the interface in each brief or add one worker that owns the contract first and land its change
   before the dependent workers start. Give every worker files it owns that no one else owns.
3. swarm_start with a title (quality gates are detected from the project; override them when the
   project's full suite is too slow). Then swarm_add a named worker per piece (@parser, @api-tests…;
   use count for a numbered pool such as @fix-1..@fix-4), each with a self-contained brief: task,
   owns, avoid and a "done when". Add a @verifier (kind "verifier") for every two to four workers to
   run the tests on the landed result; use kind "scout" for read-only investigation. Pin a different
   model for the verifier when the user asks for cross-model checking. A remote A2A agent can join with
   a2a_agent.
4. End your turn. You wake automatically when a post mentions you; idle members cost nothing.
5. When a worker passes its gates and review, swarm_land it, then mention the verifier. Steer with
   swarm_post, answer questions, and remove members that have nothing left to do.
6. When the work is verified, swarm_finish and report the result to the user.`;
}
