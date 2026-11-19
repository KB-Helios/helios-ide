import { SUBAGENT_ROSTER_PROTOCOL_VERSION, type SubagentRoster } from "@thinkrail/contracts";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { startRosterReader } from "./rosterReader";

export interface SubagentRosterState {
	/** False on hosts older than `SUBAGENT_ROSTER_PROTOCOL_VERSION`: hide the surface, never show 0. */
	supported: boolean;
	roster: SubagentRoster | null;
	stop: (parentSessionId: string, childSessionId: string) => void;
	/** The last stop request was rejected; the row stays stoppable for another try. */
	stopFailed: boolean;
}

/**
 * Workspace-wide subagent roster. Reads `subagent.roster`, then refetches on the throttled
 * `subagent.rosterChanged` invalidation and after every reconnect. Keeps no store copy.
 */
export function useSubagentRoster(workspaceId: string): SubagentRosterState {
	const status = useAppStore((state) => state.status);
	const generation = useAppStore((state) => state.connectionGeneration);
	const protocol = useAppStore((state) => state.protocolVersion);
	const supported = protocol !== null && protocol >= SUBAGENT_ROSTER_PROTOCOL_VERSION;
	const [roster, setRoster] = useState<SubagentRoster | null>(null);
	const [stopFailed, setStopFailed] = useState(false);

	useEffect(() => {
		setRoster(null);
		if (status !== "connected" || !supported) return;
		const reader = startRosterReader(workspaceId, getTransport(), setRoster);
		return () => reader.dispose();
	}, [workspaceId, status, supported, generation]);

	const stop = useCallback(
		(parentSessionId: string, childSessionId: string) => {
			setStopFailed(false);
			void getTransport()
				.request("subagent.stop", { workspaceId, parentSessionId, childSessionId })
				.catch(() => setStopFailed(true));
		},
		[workspaceId],
	);

	return { supported, roster, stop, stopFailed };
}
