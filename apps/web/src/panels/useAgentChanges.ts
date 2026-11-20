import type { GitFileChange } from "@thinkrail/contracts";
import { useMemo } from "react";
import { agentChangedFiles } from "./changesModel";
import { useWorkspaceTurns } from "./useWorkspaceTurns";

const NONE: readonly GitFileChange[] = [];

/**
 * The part of a workspace's `changes` that an agent run touched ([[submodule-web-panels]], *Changes: Agent
 * filter*) — the one derivation behind the topbar's "N files changed" pill and the Changes panel's Agent
 * filter, so the pill's number is the length of the list its click lands on. Empty while `changes` is
 * unknown.
 */
export function useAgentChanges(
	workspaceId: string | null,
	changes: readonly GitFileChange[] | null | undefined,
): readonly GitFileChange[] {
	const turns = useWorkspaceTurns(workspaceId);
	return useMemo(() => (changes ? agentChangedFiles(changes, turns) : NONE), [changes, turns]);
}
