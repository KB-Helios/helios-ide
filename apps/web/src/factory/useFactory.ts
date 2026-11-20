import {
	DAG_DETAILS_PROTOCOL_VERSION,
	DAG_PROTOCOL_VERSION,
	DAG_PUSH_PROTOCOL_VERSION,
	DAG_QUEUE_PROTOCOL_VERSION,
	DAG_REVIEW_PROTOCOL_VERSION,
	DAG_START_PROTOCOL_VERSION,
	type DagChanged,
	type DagHistoryPage,
	type DagListItem,
	type DagOutputView,
	type DagQueueView,
	type DagReviewView,
	type DagStartRequest,
	type DagStartResult,
	type DagView,
	type DagWireCommand,
	type FactoryRolesView,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomId } from "@/lib";
import { useAppStore } from "@/store";
import { getTransport, wsErrorCode } from "@/transport";

/**
 * A host older than `DAG_PUSH_PROTOCOL_VERSION` pushes `dag.changed` only after wire commands, so while
 * the pane is open such a host is re-read at this pace. A current host needs no polling.
 */
const LEGACY_REFRESH_MS = 5000;

export type FactoryFailure = "stale" | "rejected";

export interface FactoryState {
	/** `null` until the first read; an older host never reports one. */
	items: DagListItem[] | null;
	/** Worker turns of all the workspace's DAGs against its cap; `null` until read or on an older host. */
	queue: DagQueueView | null;
	selectedId: string | null;
	dag: DagView | null;
	/** Reviewer findings by node id; a node that has submitted none yet is absent. */
	reviews: Readonly<Record<string, DagReviewView>>;
	/** The host serves `dag.history` and `dag.output` (v134). */
	details: boolean;
	/** One page of the selected DAG's history, oldest first; rejects when nothing is selected. */
	history: (cursor?: string) => Promise<DagHistoryPage>;
	/** A named output of one node of the selected DAG, `null` before the node submitted. */
	output: (nodeId: string, name: string) => Promise<DagOutputView | null>;
	/** The host can start runs (v135): `roles`, `start` and `startFromPlan` work. */
	startable: boolean;
	roles: () => Promise<FactoryRolesView>;
	/** Starts a run and selects the DAG it created; rejects with the host's refusal. */
	start: (request: Omit<DagStartRequest, "workspaceId" | "commandId">) => Promise<DagStartResult>;
	/** Creates the factory DAG from the selected planning DAG's approved plan and selects it. */
	startFromPlan: (planDagId: string) => Promise<DagStartResult>;
	select: (dagId: string | null) => void;
	/** Resolves `null` once the host accepted the command. */
	run: (command: DagWireCommand) => Promise<FactoryFailure | null>;
}

/**
 * The workspace's DAGs: read once per connection and re-read on each `dag.changed` for this workspace
 * (the host debounces and pushes every committed change); only a pre-push host is polled while open. The host is the authority; nothing here is cached beyond
 * the component.
 */
export function useFactory(workspaceId: string, open: boolean): FactoryState {
	const status = useAppStore((state) => state.status);
	const generation = useAppStore((state) => state.connectionGeneration);
	const protocol = useAppStore((state) => state.protocolVersion);
	const supported = protocol !== null && protocol >= DAG_PROTOCOL_VERSION;
	const reviewable = protocol !== null && protocol >= DAG_REVIEW_PROTOCOL_VERSION;
	const queueable = protocol !== null && protocol >= DAG_QUEUE_PROTOCOL_VERSION;
	const pushed = protocol !== null && protocol >= DAG_PUSH_PROTOCOL_VERSION;
	const details = protocol !== null && protocol >= DAG_DETAILS_PROTOCOL_VERSION;
	const startable = protocol !== null && protocol >= DAG_START_PROTOCOL_VERSION;
	const [items, setItems] = useState<DagListItem[] | null>(null);
	const [queue, setQueue] = useState<DagQueueView | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dag, setDag] = useState<DagView | null>(null);
	const [reviews, setReviews] = useState<Record<string, DagReviewView>>({});
	const refreshRef = useRef<() => void>(() => {});
	const selectedRef = useRef<string | null>(null);

	useEffect(() => {
		setItems(null);
		setQueue(null);
		setDag(null);
		setReviews({});
		selectedRef.current = null;
		setSelectedId(null);
		if (status !== "connected" || !supported) return;
		const transport = getTransport();
		let disposed = false;
		const tick = { current: 0 };
		const readReviews = (view: DagView, ticket: number) => {
			for (const node of view.nodes) {
				if (!node.reviewer || node.outcome === undefined) continue;
				void transport
					.request("dag.review", { workspaceId, dagId: view.dagId, nodeId: node.id })
					.then((review) => {
						if (
							disposed ||
							ticket !== tick.current ||
							selectedRef.current !== view.dagId ||
							!review
						)
							return;
						setReviews((current) => ({ ...current, [node.id]: review }));
					})
					.catch(() => {});
			}
		};
		const refresh = () => {
			tick.current += 1;
			const ticket = tick.current;
			void transport
				.request("dag.list", { workspaceId })
				.then((list) => {
					if (!disposed && ticket === tick.current) setItems(list);
				})
				.catch(() => {});
			if (queueable)
				void transport
					.request("dag.queue", { workspaceId })
					.then((next) => {
						if (!disposed && ticket === tick.current) setQueue(next);
					})
					.catch(() => {});
			const dagId = selectedRef.current;
			if (dagId)
				void transport
					.request("dag.get", { workspaceId, dagId })
					.then((view) => {
						if (!disposed && ticket === tick.current && selectedRef.current === dagId) {
							setDag(view);
							if (reviewable) readReviews(view, ticket);
						}
					})
					.catch(() => {});
		};
		refreshRef.current = refresh;
		const unsubscribe = transport.subscribe(WS_CHANNELS.dagChanged, (payload) => {
			if ((payload as DagChanged).workspaceId === workspaceId) refresh();
		});
		refresh();
		const timer = open && !pushed ? setInterval(refresh, LEGACY_REFRESH_MS) : undefined;
		return () => {
			disposed = true;
			refreshRef.current = () => {};
			unsubscribe();
			if (timer !== undefined) clearInterval(timer);
		};
	}, [workspaceId, status, supported, reviewable, queueable, pushed, generation, open]);

	const select = useCallback((dagId: string | null) => {
		selectedRef.current = dagId;
		setSelectedId(dagId);
		setDag(null);
		setReviews({});
		refreshRef.current();
	}, []);

	const run = useCallback(
		async (command: DagWireCommand): Promise<FactoryFailure | null> => {
			if (!dag) return "stale";
			try {
				const result = await getTransport().request("dag.execute", {
					workspaceId,
					dagId: dag.dagId,
					commandId: randomId("ui"),
					expectedVersion: dag.version,
					command,
				});
				if (selectedRef.current === result.dag.dagId) setDag(result.dag);
				refreshRef.current();
				return null;
			} catch (error) {
				refreshRef.current();
				return wsErrorCode(error) === "DAG_STALE" ? "stale" : "rejected";
			}
		},
		[workspaceId, dag],
	);

	const history = useCallback(
		(cursor?: string) => {
			const dagId = selectedRef.current;
			if (!dagId) return Promise.reject(new Error("No workflow selected"));
			return getTransport().request("dag.history", {
				workspaceId,
				dagId,
				...(cursor ? { cursor } : {}),
			});
		},
		[workspaceId],
	);

	const output = useCallback(
		(nodeId: string, name: string) => {
			const dagId = selectedRef.current;
			if (!dagId) return Promise.reject(new Error("No workflow selected"));
			return getTransport().request("dag.output", { workspaceId, dagId, nodeId, name });
		},
		[workspaceId],
	);

	const roles = useCallback(
		() => getTransport().request("dag.roles", { workspaceId }),
		[workspaceId],
	);

	const start = useCallback(
		async (request: Omit<DagStartRequest, "workspaceId" | "commandId">) => {
			const result = await getTransport().request("dag.start", {
				...request,
				workspaceId,
				commandId: randomId("ui-start"),
			});
			select(result.dagId);
			return result;
		},
		[workspaceId, select],
	);

	const startFromPlan = useCallback(
		async (planDagId: string) => {
			const result = await getTransport().request("dag.startFromPlan", { workspaceId, planDagId });
			select(result.dagId);
			return result;
		},
		[workspaceId, select],
	);

	return {
		items,
		queue,
		selectedId,
		dag,
		reviews,
		details,
		history,
		output,
		startable,
		roles,
		start,
		startFromPlan,
		select,
		run,
	};
}
