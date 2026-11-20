import { useEffect, useMemo } from "react";
import { isConnectedGeneration, useAppStore } from "../store";
import { getTransport, supportsCommitAnalysis } from "../transport";

const EMPTY = { shas: [] as string[], pending: [] as string[] };

export function useCommitAnalysisIndex(workspaceId: string | null): {
	shas: ReadonlySet<string>;
	pending: ReadonlySet<string>;
} {
	const index =
		useAppStore((state) =>
			workspaceId ? state.commitAnalysesByWorkspace[workspaceId] : undefined,
		) ?? EMPTY;
	return useMemo(() => ({ shas: new Set(index.shas), pending: new Set(index.pending) }), [index]);
}

export function useLoadCommitAnalysisIndex(workspaceId: string | null): void {
	const supported = useAppStore((state) => supportsCommitAnalysis(state.protocolVersion));
	const generation = useAppStore((state) => state.connectionGeneration);
	useEffect(() => {
		if (!workspaceId || !supported) return;
		if (!isConnectedGeneration(useAppStore.getState(), generation)) return;
		let cancelled = false;
		getTransport()
			.request("commit.analysisList", { workspaceId })
			.then((index) => {
				if (!cancelled) useAppStore.getState().installCommitAnalysisIndex(workspaceId, index);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [generation, supported, workspaceId]);
}
