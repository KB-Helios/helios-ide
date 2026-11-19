import type { Swarm } from "./swarm.ts";

export interface Membership {
	swarm: Swarm;
	member: string;
}

const memberships = new Map<string, Membership>();

/** Child session id → swarm membership, so the curated child extension can serve the member tools. */
export function rememberMember(childSessionId: string, membership: Membership): void {
	memberships.set(childSessionId, membership);
}

export function forgetMember(childSessionId: string): void {
	memberships.delete(childSessionId);
}

export function membershipOf(childSessionId: string): Membership | undefined {
	return memberships.get(childSessionId);
}
