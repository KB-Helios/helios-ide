import { RiAlertLine, RiCheckLine, RiFlowChart, RiLoader4Line, RiTimeLine } from "@remixicon/react";
import type {
	DagGateView,
	DagNodeStatus,
	DagNodeView,
	DagReviewSeverity,
	DagReviewView,
	DagView,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@thinkrail/ui/dialog";
import { Textarea } from "@thinkrail/ui/textarea";
import { cn } from "@thinkrail/ui/utils";
import { useState } from "react";
import { formatCost, formatTokens } from "@/chat/SessionStatsBar";
import {
	bySeverity,
	dependsOn,
	needsAttention,
	orderNodes,
	pendingTotal,
	totalUsage,
} from "./factoryModel";
import { type FactoryFailure, useFactory } from "./useFactory";

type T = ReturnType<typeof useT>;

function statusLabel(t: T, status: DagNodeStatus): string {
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

function severityLabel(t: T, severity: DagReviewSeverity): string {
	return {
		critical: t("factory.review.severity.critical"),
		high: t("factory.review.severity.high"),
		medium: t("factory.review.severity.medium"),
		low: t("factory.review.severity.low"),
		info: t("factory.review.severity.info"),
	}[severity];
}

/** Glyph + word + colour together, so state never rests on colour alone. */
function StatusGlyph({ status }: { status: DagNodeStatus }) {
	if (needsAttention(status))
		return <RiAlertLine className="mt-2 size-14 shrink-0 text-feedback-warning" aria-hidden />;
	if (status === "completed")
		return <RiCheckLine className="mt-2 size-14 shrink-0 text-feedback-success" aria-hidden />;
	if (status === "running")
		return (
			<RiLoader4Line
				className="mt-2 size-14 shrink-0 text-text-default motion-safe:animate-spin"
				aria-hidden
			/>
		);
	if (status === "cancelled")
		return <RiAlertLine className="mt-2 size-14 shrink-0 text-feedback-error" aria-hidden />;
	return <RiTimeLine className="mt-2 size-14 shrink-0 text-text-muted" aria-hidden />;
}

function NodeRow({ node, dag }: { node: DagNodeView; dag: DagView }) {
	const t = useT();
	const after = dependsOn(dag, node.id);
	return (
		<li
			className="flex items-start gap-8 px-12 py-8"
			data-testid="factory-node"
			data-status={node.status}
		>
			<StatusGlyph status={node.status} />
			<span className="min-w-0 flex-1">
				<span className="flex flex-wrap items-baseline gap-x-8">
					<span className="tr-text-emphasis">{node.id}</span>
					<span className="tr-text-metadata text-text-muted">{statusLabel(t, node.status)}</span>
					{node.held ? (
						<span className="tr-text-metadata text-text-muted">{t("factory.node.held")}</span>
					) : null}
				</span>
				<span className="block truncate tr-text-metadata text-text-muted">{node.task}</span>
				{node.model || node.usage ? (
					<span
						className="flex flex-wrap gap-x-8 tr-text-metadata text-text-muted"
						data-testid="factory-node-run"
					>
						{node.model ? (
							<span className="wrap-anywhere">
								{node.thinkingLevel && node.thinkingLevel !== "off"
									? `${node.model} · ${t("factory.node.thinking", { level: node.thinkingLevel })}`
									: node.model}
							</span>
						) : null}
						{node.usage ? (
							<span className="tabular-nums">
								{t("factory.usage.tokens", {
									input: formatTokens(node.usage.input),
									output: formatTokens(node.usage.output),
								})}
								{node.usage.cost > 0 ? ` · ${formatCost(node.usage.cost)}` : ""}
							</span>
						) : null}
						{node.outcome && node.outcome !== "completed" ? (
							<span className="text-feedback-error">
								{node.outcome === "error"
									? t("factory.node.ended.error")
									: t("factory.node.ended.aborted")}
							</span>
						) : null}
					</span>
				) : null}
				{after.length ? (
					<span className="block tr-text-metadata text-text-muted">
						{t("factory.node.after", { names: after.join(", ") })}
					</span>
				) : null}
			</span>
		</li>
	);
}

function ReviewFindings({ review }: { review: DagReviewView }) {
	const t = useT();
	return (
		<div className="flex flex-col gap-4" data-testid="factory-review">
			<span className="tr-text-emphasis">
				{t("factory.review.count", { count: review.valid ? review.total : 0 })}
				{review.model ? (
					<span className="tr-text-metadata text-text-muted">
						{" · "}
						{t("factory.review.by", { model: review.model })}
					</span>
				) : null}
			</span>
			{!review.valid ? (
				<span role="alert" className="tr-text-metadata text-feedback-warning">
					{t("factory.review.invalid")}
				</span>
			) : review.total === 0 ? (
				<span className="tr-text-metadata text-text-muted">{t("factory.review.none")}</span>
			) : (
				<ul className="flex flex-col gap-4">
					{bySeverity(review.findings).map((finding, index) => (
						<li key={index} className="tr-text-ui" data-severity={finding.severity}>
							<span className="tr-text-metadata text-feedback-warning">
								{severityLabel(t, finding.severity)}
							</span>{" "}
							<span className="tr-text-metadata text-text-muted wrap-anywhere">{finding.file}</span>
							<span className="block wrap-anywhere">{finding.summary}</span>
						</li>
					))}
				</ul>
			)}
			{review.truncated ? (
				<span className="tr-text-metadata text-text-muted">
					{t("factory.review.more", { count: review.total - review.findings.length })}
				</span>
			) : null}
		</div>
	);
}

function GateCard({
	gate,
	review,
	run,
}: {
	gate: DagGateView;
	review?: DagReviewView | undefined;
	run: (
		command: Parameters<ReturnType<typeof useFactory>["run"]>[0],
	) => Promise<FactoryFailure | null>;
}) {
	const t = useT();
	const [text, setText] = useState("");
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<FactoryFailure | null>(null);
	const send = async (command: Parameters<typeof run>[0]) => {
		setBusy(true);
		setFailure(await run(command));
		setBusy(false);
	};
	const trimmed = text.trim();
	return (
		<li className="flex flex-col gap-8 px-12 py-8" data-testid="factory-gate" data-kind={gate.kind}>
			<div className="flex flex-wrap items-baseline gap-x-8 tr-text-metadata text-text-muted">
				<span className="tr-text-emphasis text-text-default">
					{gate.kind === "approval" ? t("factory.gate.approval") : t("factory.gate.input")}
				</span>
				<span>{t("factory.gate.target", { node: gate.target.nodeId })}</span>
			</div>
			<p className="whitespace-pre-wrap wrap-anywhere tr-text-ui text-text-default">
				{gate.question}
			</p>
			{review ? <ReviewFindings review={review} /> : null}
			<Textarea
				rows={2}
				value={text}
				onChange={(event) => setText(event.target.value)}
				placeholder={gate.kind === "approval" ? t("factory.gate.reason") : t("factory.gate.answer")}
				aria-label={gate.kind === "approval" ? t("factory.gate.reason") : t("factory.gate.answer")}
				disabled={busy}
				data-testid="factory-gate-text"
			/>
			<div className="flex flex-wrap items-center gap-8">
				{gate.kind === "approval" ? (
					<>
						<Button
							variant="primary"
							size="m"
							disabled={busy}
							onClick={() =>
								send({
									kind: "approve",
									gateId: gate.id,
									reason: trimmed || t("factory.gate.approvedDefault"),
								})
							}
							data-testid="factory-approve"
						>
							{t("factory.gate.approve")}
						</Button>
						<Button
							variant="outline"
							size="m"
							disabled={busy || trimmed.length === 0}
							onClick={() => send({ kind: "reject", gateId: gate.id, reason: trimmed })}
							data-testid="factory-reject"
						>
							{t("factory.gate.reject")}
						</Button>
					</>
				) : (
					<Button
						variant="primary"
						size="m"
						disabled={busy || trimmed.length === 0}
						onClick={() => send({ kind: "answer", gateId: gate.id, text: trimmed })}
						data-testid="factory-answer"
					>
						{t("factory.gate.send")}
					</Button>
				)}
				{failure ? (
					<span role="alert" className="tr-text-metadata text-feedback-error">
						{failure === "stale" ? t("factory.error.stale") : t("factory.error.rejected")}
					</span>
				) : null}
			</div>
		</li>
	);
}

function DagDetail({
	dag,
	reviews,
	run,
}: {
	dag: DagView;
	reviews: Readonly<Record<string, DagReviewView>>;
	run: Parameters<typeof GateCard>[0]["run"];
}) {
	const t = useT();
	const [failure, setFailure] = useState<FactoryFailure | null>(null);
	const control = async (kind: "pause" | "resume") => setFailure(await run({ kind }));
	const active = dag.lifecycle === "active";
	const total = totalUsage(dag.nodes);
	return (
		<div className="flex min-h-0 flex-col gap-8" data-testid="factory-detail">
			<div className="flex flex-wrap items-center gap-8 px-12">
				<span className="tr-text-metadata text-text-muted">
					{dag.mode === "running" ? t("factory.mode.running") : t("factory.mode.paused")}
				</span>
				{dag.executionOwner === "other" ? (
					<span className="tr-text-metadata text-feedback-warning">{t("factory.owner.other")}</span>
				) : null}
				{active && dag.mode === "paused" ? (
					<Button
						variant="outline"
						size="m"
						onClick={() => control("resume")}
						data-testid="factory-resume"
					>
						{t("factory.action.resume")}
					</Button>
				) : null}
				{active && dag.mode === "running" ? (
					<Button
						variant="outline"
						size="m"
						onClick={() => control("pause")}
						data-testid="factory-pause"
					>
						{t("factory.action.pause")}
					</Button>
				) : null}
				{total ? (
					<span
						className="tr-text-metadata tabular-nums text-text-muted"
						data-testid="factory-total"
					>
						{t("factory.usage.total", {
							input: formatTokens(total.input),
							output: formatTokens(total.output),
							cost: formatCost(total.cost),
						})}
					</span>
				) : null}
				{failure ? (
					<span role="alert" className="tr-text-metadata text-feedback-error">
						{failure === "stale" ? t("factory.error.stale") : t("factory.error.rejected")}
					</span>
				) : null}
			</div>
			<section aria-label={t("factory.gates.heading")}>
				<h3 className="px-12 pt-8 tr-text-metadata text-text-muted">
					{t("factory.gates.heading")} ({dag.gates.length})
				</h3>
				{dag.gates.length ? (
					<ul className="divide-y divide-border-default">
						{dag.gates.map((gate) => (
							<GateCard key={gate.id} gate={gate} review={reviews[gate.target.nodeId]} run={run} />
						))}
					</ul>
				) : (
					<p className="px-12 py-8 tr-text-ui text-text-muted">{t("factory.gates.none")}</p>
				)}
			</section>
			<section aria-label={t("factory.nodes.heading")}>
				<h3 className="px-12 pt-8 tr-text-metadata text-text-muted">
					{t("factory.nodes.heading")} ({dag.nodes.length})
				</h3>
				<ul className="max-h-[40vh] divide-y divide-border-default overflow-y-auto">
					{orderNodes(dag.nodes).map((node) => (
						<NodeRow key={node.id} node={node} dag={dag} />
					))}
				</ul>
			</section>
		</div>
	);
}

/** Chat-header trigger and pane for the workspace's durable DAGs: nodes, pending gates and decisions. */
export function FactoryTrigger({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const { items, selectedId, dag, reviews, select, run } = useFactory(workspaceId, open);
	if (!items?.length) return null;
	const pending = pendingTotal(items);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="m"
					iconLeft={RiFlowChart}
					className="shrink-0"
					data-testid="factory-trigger"
					data-pending={pending}
					aria-label={t("factory.trigger.aria", { count: pending })}
				>
					<span className="hidden @[480px]:inline">{t("factory.trigger.label")}</span>
					<span className={cn("tabular-nums", pending > 0 && "text-feedback-warning")}>
						{pending}
					</span>
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-[48rem]" data-testid="factory-pane">
				<DialogTitle>{t("factory.trigger.label")}</DialogTitle>
				<DialogDescription>{t("factory.description")}</DialogDescription>
				<ul className="max-h-[24vh] divide-y divide-border-default overflow-y-auto">
					{items.map((item) => (
						<li key={item.dagId}>
							<button
								type="button"
								className="flex w-full items-baseline gap-8 px-12 py-8 text-left hover:bg-control-bg-hovered focus-visible:focus-ring-inset"
								aria-pressed={selectedId === item.dagId}
								onClick={() => select(selectedId === item.dagId ? null : item.dagId)}
								data-testid="factory-dag"
							>
								<span className="min-w-0 flex-1 truncate tr-text-emphasis">{item.title}</span>
								<span className="tr-text-metadata text-text-muted">
									{item.mode === "running" ? t("factory.mode.running") : t("factory.mode.paused")}
								</span>
								{item.pendingGates > 0 ? (
									<span className="tr-text-metadata text-feedback-warning">
										{t("factory.list.pending", { count: item.pendingGates })}
									</span>
								) : null}
							</button>
						</li>
					))}
				</ul>
				{dag ? (
					<DagDetail key={dag.dagId} dag={dag} reviews={reviews} run={run} />
				) : (
					<p className="px-12 py-8 tr-text-ui text-text-muted">{t("factory.select")}</p>
				)}
			</DialogContent>
		</Dialog>
	);
}
