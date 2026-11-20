import {
	DAG_PROTOCOL_VERSION,
	DAG_REVIEW_PROTOCOL_VERSION,
	type DagChanged,
	type DagListItem,
	type DagReviewView,
	type DagView,
	type DagWireCommand,
	WS_CHANNELS,
} from "@thinkrail/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomId } from "@/lib";
import { useAppStore } from "@/store";
import { getTransport, wsErrorCode } from "@/transport";

/** While the pane is open the host is re-read at this pace: chat and worker progress is not pushed. */
const OPEN_REFRESH_MS = 5000;

export type FactoryFailure = "stale" | "rejected";

export interface FactoryState {
	/** `null` until the first read; an older host never reports one. */
	items: DagListItem[] | null;
	selectedId: string | null;
	dag: DagView | null;
	/** Reviewer findings by node id; a node that has submitted none yet is absent. */
	reviews: Readonly<Record<string, DagReviewView>>;
	select: (dagId: string | null) => void;
	/** Resolves `null` once the host accepted the command. */
	run: (command: DagWireCommand) => Promise<FactoryFailure | null>;
}

/**
 * The workspace's DAGs: read once per connection, re-read on each `dag.changed` for this workspace and,
 * while the pane is open, on a slow interval. The host is the authority; nothing here is cached beyond
 * the component.
 */
export function useFactory(workspaceId: string, open: boolean): FactoryState {
	const status = useAppStore((state) => state.status);
	const generation = useAppStore((state) => state.connectionGeneration);
	const protocol = useAppStore((state) => state.protocolVersion);
	const supported = protocol !== null && protocol >= DAG_PROTOCOL_VERSION;
	const reviewable = protocol !== null && protocol >= DAG_REVIEW_PROTOCOL_VERSION;
	const [items, setItems] = useState<DagListItem[] | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [dag, setDag] = useState<DagView | null>(null);
	const [reviews, setReviews] = useState<Record<string, DagReviewView>>({});
	const refreshRef = useRef<() => void>(() => {});
	const selectedRef = useRef<string | null>(null);
	selectedRef.current = selectedId;

	useEffect(() => {
		setItems(null);
		setDag(null);
		setReviews({});
		setSelectedId(null);
		if (status !== "connected" || !supported) return;
		const transport = getTransport();
		let disposed = false;
		let serial = 0;
		const readReviews = (view: DagView, ticket: number) => {
			for (const node of view.nodes) {
				if (!node.reviewer || node.outcome === undefined) continue;
				void transport
					.request("dag.review", { workspaceId, dagId: view.dagId, nodeId: node.id })
					.then((review) => {
						if (disposed || ticket !== serial || selectedRef.current !== view.dagId || !review)
							return;
						setReviews((current) => ({ ...current, [node.id]: review }));
					})
					.catch(() => {});
			}
		};
		const refresh = () => {
			const ticket = ++serial;
			void transport
				.request("dag.list", { workspaceId })
				.then((list) => {
					if (!disposed && ticket === serial) setItems(list);
				})
				.catch(() => {});
			const dagId = selectedRef.current;
			if (dagId)
				void transport
					.request("dag.get", { workspaceId, dagId })
					.then((view) => {
						if (!disposed && ticket === serial && selectedRef.current === dagId) {
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
		const timer = open ? setInterval(refresh, OPEN_REFRESH_MS) : undefined;
		return () => {
			disposed = true;
			refreshRef.current = () => {};
			unsubscribe();
			if (timer !== undefined) clearInterval(timer);
		};
	}, [workspaceId, status, supported, reviewable, generation, open]);

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

	return { items, selectedId, dag, reviews, select, run };
}
