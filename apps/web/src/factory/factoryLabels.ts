import type { DagNodeStatus } from "@thinkrail/contracts";
import type { useT } from "@thinkrail/locales/react";

type T = ReturnType<typeof useT>;

/** The word for a node status; every surface that shows a status shows this word beside its glyph or colour. */
export function statusLabel(t: T, status: DagNodeStatus): string {
	return {
		pending: t("factory.status.pending"),
		queued: t("factory.status.queued"),
		running: t("factory.status.running"),
		"waiting-input": t("factory.status.waitingInput"),
		"waiting-approval": t("factory.status.waitingApproval"),
		"needs-attention": t("factory.status.needsAttention"),
		interrupted: t("factory.status.interrupted"),
		uncertain: t("factory.status.uncertain"),
		stale: t("factory.status.stale"),
		completed: t("factory.status.completed"),
		cancelled: t("factory.status.cancelled"),
		skipped: t("factory.status.skipped"),
	}[status];
}
