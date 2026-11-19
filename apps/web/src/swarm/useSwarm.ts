import {
	SWARM_PROTOCOL_VERSION,
	type SwarmChanged,
	type SwarmDiff,
	type SwarmSnapshot,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/store";
import { getTransport } from "@/transport";

export interface SwarmState {
	snapshot: SwarmSnapshot | null;
	readDiff: (member: string) => Promise<SwarmDiff>;
}

/** This chat's swarm board: read once, then replaced by every `swarm.changed` snapshot for the chat. */
export function useSwarm(workspaceId: string, sessionId: string): SwarmState {
	const status = useAppStore((state) => state.status);
	const generation = useAppStore((state) => state.connectionGeneration);
	const protocol = useAppStore((state) => state.protocolVersion);
	const supported = protocol !== null && protocol >= SWARM_PROTOCOL_VERSION;
	const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null);

	useEffect(() => {
		setSnapshot(null);
		if (status !== "connected" || !supported) return;
		const transport = getTransport();
		let disposed = false;
		let pushed = false;
		const unsubscribe = transport.subscribe(WS_CHANNELS.swarmChanged, (payload) => {
			const change = payload as SwarmChanged;
			if (change.workspaceId !== workspaceId || change.sessionId !== sessionId) return;
			pushed = true;
			setSnapshot(change.snapshot);
		});
		void transport
			.request("swarm.get", { workspaceId, sessionId })
			.then((read) => {
				if (!disposed && !pushed) setSnapshot(read);
			})
			.catch(() => {});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [workspaceId, sessionId, status, supported, generation]);

	const readDiff = useCallback(
		(member: string) => getTransport().request("swarm.diff", { workspaceId, sessionId, member }),
		[workspaceId, sessionId],
	);

	return { snapshot, readDiff };
}
