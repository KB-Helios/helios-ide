import { join } from "node:path";
import type { SwarmChanged, SwarmDiff, SwarmSnapshot } from "@thinkrail/contracts";
import { createSwarm, type SwarmOwner } from "pi-swarm";
import { dataDir } from "../persistence";
import { delegationServiceFor } from "./delegation";

const owners = new Map<string, { workspaceId: string; owner: SwarmOwner }>();
let publish: (payload: SwarmChanged) => void = () => {};

export function setSwarmPublisher(next: ((payload: SwarmChanged) => void) | null): void {
	publish = next ?? (() => {});
}

export function swarmWorktreeRoot(workspaceId: string): string {
	return join(dataDir(), "swarm-worktrees", workspaceId);
}

/** The per-session swarm owner: its coordinator tools live in the session, its members are delegation children. */
export function swarmFor(
	workspaceId: string,
	sessionId: string,
	canDeliver: () => boolean,
): SwarmOwner {
	const owner = createSwarm({
		service: delegationServiceFor(workspaceId),
		worktreeRoot: swarmWorktreeRoot(workspaceId),
		canDeliver,
		onChange: (snapshot) => publish({ workspaceId, sessionId, snapshot }),
	});
	owners.set(sessionId, { workspaceId, owner });
	return owner;
}

export async function disposeSessionSwarm(sessionId: string): Promise<void> {
	const entry = owners.get(sessionId);
	owners.delete(sessionId);
	await entry?.owner.dispose().catch(() => {});
}

function ownedSwarm(workspaceId: string, sessionId: string) {
	const entry = owners.get(sessionId);
	return entry?.workspaceId === workspaceId ? entry.owner.current() : undefined;
}

export function readSessionSwarm(workspaceId: string, sessionId: string): SwarmSnapshot | null {
	return ownedSwarm(workspaceId, sessionId)?.snapshot() ?? null;
}

const MAX_PATCH = 400_000;

export async function readSwarmMemberDiff(
	workspaceId: string,
	sessionId: string,
	member: string,
): Promise<SwarmDiff> {
	const swarm = ownedSwarm(workspaceId, sessionId);
	if (!swarm) throw new Error("No swarm in this chat");
	const { patch, stat } = await swarm.diff(member);
	return patch.length > MAX_PATCH
		? { member, stat, patch: patch.slice(0, MAX_PATCH), truncated: true }
		: { member, stat, patch, truncated: false };
}
