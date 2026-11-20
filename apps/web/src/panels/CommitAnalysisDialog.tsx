import type { CommitAnalysisRecord } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@thinkrail/ui/dialog";
import { LoadingRegion } from "@thinkrail/ui/skeleton";
import { useEffect, useState } from "react";
import { getTransport } from "../transport";
import { CommitAnalysisView } from "./CommitAnalysisView";

export function CommitAnalysisDialog({
	workspaceId,
	sha,
	open,
	onOpenChange,
}: {
	workspaceId: string;
	sha: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const [record, setRecord] = useState<CommitAnalysisRecord | null | undefined>(undefined);
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setRecord(undefined);
		getTransport()
			.request("commit.analysis", { workspaceId, sha })
			.then((next) => {
				if (!cancelled) setRecord(next);
			})
			.catch(() => {
				if (!cancelled) setRecord(null);
			});
		return () => {
			cancelled = true;
		};
	}, [open, workspaceId, sha]);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-[40rem]" data-testid="commit-analysis-dialog">
				<DialogHeader>
					<DialogTitle>
						{t("changes.commitAnalysis.title", { shortSha: sha.slice(0, 7) })}
					</DialogTitle>
				</DialogHeader>
				{record === undefined ? (
					<LoadingRegion rows={4} label={t("changes.commitAnalysis.loading")} />
				) : record === null ? (
					<p className="text-text-muted">{t("changes.commitAnalysis.failed")}</p>
				) : (
					<div className="max-h-[70vh] overflow-y-auto">
						<CommitAnalysisView record={record} />
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
}
