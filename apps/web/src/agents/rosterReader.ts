import { type SubagentRoster, WS_CHANNELS } from "@thinkrail/contracts";

const RETRY_DELAYS_MS = [1000, 3000, 8000];

interface RosterTransport {
	request(method: "subagent.roster", params: { workspaceId: string }): Promise<SubagentRoster>;
	subscribe(channel: string, handler: (payload: unknown) => void): () => void;
}

/**
 * Reads the workspace roster, then rereads on each `subagent.rosterChanged` invalidation. Reads are
 * single-flight, a failed read retries a bounded number of times, and a response older than the one held
 * is dropped.
 */
export function startRosterReader(
	workspaceId: string,
	transport: RosterTransport,
	onRoster: (update: (prev: SubagentRoster | null) => SubagentRoster | null) => void,
): { dispose: () => void } {
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
				onRoster((prev) =>
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

	onRoster(() => null);
	const unsubscribe = transport.subscribe(WS_CHANNELS.subagentRosterChanged, (payload) => {
		if ((payload as { workspaceId?: string }).workspaceId === workspaceId) read();
	});
	read();
	return {
		dispose() {
			disposed = true;
			if (retry !== undefined) clearTimeout(retry);
			unsubscribe();
		},
	};
}
