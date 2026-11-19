import {
	SUBAGENT_ROSTER_PROTOCOL_VERSION,
	type SubagentRoster,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { getTransport } from "@/transport";

export interface SubagentRosterState {
	/** False on hosts older than `SUBAGENT_ROSTER_PROTOCOL_VERSION`: hide the surface, never show 0. */
	supported: boolean;
	roster: SubagentRoster | null;
	stop: (parentSessionId: string, childSessionId: string) => void;
	/** The last stop request was rejected; the row stays stoppable for another try. */
	stopFailed: boolean;
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];

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
		const transport = getTransport();
		let disposed = false;
		let reading = false;
		let again = false;
		let failures = 0;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const read = () => {
			if (reading) {
				again = true;
				return;
			}
			reading = true;
			transport
				.request("subagent.roster", { workspaceId })
				.then((next) => {
					if (disposed) return;
					failures = 0;
					setRoster((prev) =>
						prev && prev.revision > next.revision && prev.workspaceId === next.workspaceId
							? prev
							: next,
					);
				})
				.catch(() => {
					const delay = RETRY_DELAYS_MS[failures++];
					if (disposed || delay === undefined || retry !== undefined) return;
					retry = setTimeout(() => {
						retry = undefined;
						read();
					}, delay);
				})
				.finally(() => {
					reading = false;
					if (again && !disposed) {
						again = false;
						read();
					}
				});
		};
		const unsubscribe = transport.subscribe(WS_CHANNELS.subagentRosterChanged, (payload) => {
			if ((payload as { workspaceId?: string }).workspaceId === workspaceId) read();
		});
		read();
		return () => {
			disposed = true;
			if (retry !== undefined) clearTimeout(retry);
			unsubscribe();
		};
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
