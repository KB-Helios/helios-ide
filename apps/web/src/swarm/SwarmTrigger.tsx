import {
	RiAlertLine,
	RiCheckLine,
	RiGitBranchLine,
	RiLoader4Line,
	RiPauseLine,
	RiTeamLine,
} from "@remixicon/react";
import type { SwarmDiff, SwarmMember, SwarmPost, SwarmSnapshot } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@thinkrail/ui/dialog";
import { ToggleSegment } from "@thinkrail/ui/toggle-segment";
import { cn } from "@thinkrail/ui/utils";
import { useState } from "react";
import {
	diffLines,
	filterPosts,
	groupMembers,
	layoutGraph,
	liveCount,
	postsUntil,
} from "./swarmModel";
import { useSwarm } from "./useSwarm";

type Tab = "board" | "members" | "graph";
type T = ReturnType<typeof useT>;

function kindLabel(t: T, kind: SwarmPost["kind"]): string {
	return {
		brief: t("swarm.kind.brief"),
		message: t("swarm.kind.message"),
		report: t("swarm.kind.report"),
		gate: t("swarm.kind.gate"),
		review: t("swarm.kind.review"),
		system: t("swarm.kind.system"),
	}[kind];
}

function memberKindLabel(t: T, kind: SwarmMember["kind"]): string {
	return {
		worker: t("swarm.memberKind.worker"),
		verifier: t("swarm.memberKind.verifier"),
		reviewer: t("swarm.memberKind.reviewer"),
		scout: t("swarm.memberKind.scout"),
		custom: t("swarm.memberKind.custom"),
		a2a: t("swarm.memberKind.a2a"),
	}[kind];
}

function phaseLabel(t: T, phase: SwarmMember["phase"]): string {
	return {
		working: t("swarm.phase.working"),
		gating: t("swarm.phase.gating"),
		reviewing: t("swarm.phase.reviewing"),
		"needs-fixes": t("swarm.phase.needsFixes"),
		done: t("swarm.phase.done"),
	}[phase];
}

const DIFF_TONE = {
	add: "text-feedback-success",
	remove: "text-feedback-error",
	meta: "text-text-muted",
	plain: "text-text-default",
} as const;

function PostRow({ post }: { post: SwarmPost }) {
	const t = useT();
	return (
		<li className="flex flex-col gap-2 px-12 py-8" data-testid="swarm-post" data-kind={post.kind}>
			<div className="flex flex-wrap items-baseline gap-x-8 tr-text-metadata text-text-muted">
				<span className="tabular-nums">#{post.seq}</span>
				<span className="tr-text-emphasis text-text-default">@{post.from}</span>
				{post.to.length ? (
					<span>{t("swarm.board.to", { names: post.to.map((n) => `@${n}`).join(" ") })}</span>
				) : null}
				<span>{kindLabel(t, post.kind)}</span>
				<span>{new Date(post.at).toLocaleTimeString()}</span>
			</div>
			<p
				className={cn(
					"whitespace-pre-wrap wrap-anywhere tr-text-ui",
					post.kind === "gate" || post.kind === "system" ? "text-text-muted" : "text-text-default",
				)}
			>
				{post.text}
			</p>
		</li>
	);
}

function Board({ snapshot }: { snapshot: SwarmSnapshot }) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [member, setMember] = useState<string | null>(null);
	const posts = filterPosts(snapshot.posts, query, member);
	return (
		<div className="flex min-h-0 flex-col gap-8">
			<div className="flex flex-wrap items-center gap-8">
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("swarm.board.search")}
					aria-label={t("swarm.board.search")}
					className="min-w-0 flex-1 rounded-md border border-border-default bg-control-bg px-8 py-4 tr-text-ui"
					data-testid="swarm-search"
				/>
				<select
					value={member ?? ""}
					onChange={(event) => setMember(event.target.value || null)}
					aria-label={t("swarm.board.filter")}
					className="rounded-md border border-border-default bg-control-bg px-8 py-4 tr-text-ui"
				>
					<option value="">{t("swarm.board.everyone")}</option>
					<option value="coordinator">{t("swarm.board.coordinator")}</option>
					{snapshot.members.map((m) => (
						<option key={m.name} value={m.name}>
							@{m.name}
						</option>
					))}
				</select>
			</div>
			<ul className="max-h-[60vh] divide-y divide-border-default overflow-y-auto">
				{posts.map((post) => (
					<PostRow key={post.seq} post={post} />
				))}
			</ul>
		</div>
	);
}

function StatusIcon({ member }: { member: SwarmMember }) {
	if (member.status === "paused" || member.phase === "needs-fixes")
		return <RiAlertLine aria-hidden="true" className="size-16 shrink-0 text-feedback-warning" />;
	if (member.phase === "done")
		return <RiCheckLine aria-hidden="true" className="size-16 shrink-0 text-feedback-success" />;
	if (member.status === "active" || member.phase === "gating" || member.phase === "reviewing")
		return (
			<RiLoader4Line aria-hidden="true" className="size-16 shrink-0 motion-safe:animate-spin" />
		);
	return <RiPauseLine aria-hidden="true" className="size-16 shrink-0 text-text-muted" />;
}

function DiffView({ diff }: { diff: SwarmDiff }) {
	const t = useT();
	if (!diff.patch) return <p className="tr-text-ui text-text-muted">{t("swarm.diff.empty")}</p>;
	return (
		<div className="flex flex-col gap-4">
			<pre className="whitespace-pre-wrap tr-text-metadata text-text-muted">{diff.stat}</pre>
			<pre
				className="max-h-[40vh] overflow-auto rounded-md border border-border-default p-8 tr-code-text-small"
				data-testid="swarm-diff"
			>
				{diffLines(diff.patch).map((line) => (
					<div key={line.key} className={DIFF_TONE[line.tone]}>
						{line.text || " "}
					</div>
				))}
			</pre>
			{diff.truncated ? (
				<p className="tr-text-metadata text-text-muted">{t("swarm.diff.truncated")}</p>
			) : null}
		</div>
	);
}

function MemberDetail({
	member,
	readDiff,
}: {
	member: SwarmMember;
	readDiff: (name: string) => Promise<SwarmDiff>;
}) {
	const t = useT();
	const [diff, setDiff] = useState<SwarmDiff | null>(null);
	const [failed, setFailed] = useState(false);
	return (
		<div className="flex flex-col gap-8 px-12 pb-12" data-testid="swarm-member-detail">
			<p className="whitespace-pre-wrap tr-text-ui text-text-default">{member.brief.task}</p>
			{member.brief.owns.length ? (
				<p className="tr-text-metadata text-text-muted">
					{t("swarm.member.owns", { paths: member.brief.owns.join(", ") })}
				</p>
			) : null}
			{member.gates?.length ? (
				<ul className="flex flex-col gap-2">
					{member.gates.map((gate) => (
						<li
							key={gate.command}
							className={cn(
								"tr-text-metadata",
								gate.ok ? "text-feedback-success" : "text-feedback-error",
							)}
						>
							{gate.ok
								? t("swarm.gate.passed", { command: gate.command })
								: t("swarm.gate.failed", { command: gate.command })}
						</li>
					))}
				</ul>
			) : null}
			{member.ownershipViolations?.length ? (
				<p className="tr-text-metadata text-feedback-error">
					{t("swarm.member.violations", { paths: member.ownershipViolations.join(", ") })}
				</p>
			) : null}
			{member.review ? (
				<details>
					<summary
						className={cn(
							"cursor-pointer tr-text-metadata",
							member.review.verdict === "approve"
								? "text-feedback-success"
								: "text-feedback-warning",
						)}
					>
						{member.review.verdict === "approve"
							? t("swarm.review.approved")
							: t("swarm.review.changes")}
					</summary>
					<p className="whitespace-pre-wrap tr-text-metadata text-text-muted">
						{member.review.summary}
					</p>
				</details>
			) : null}
			{member.error ? <p className="tr-text-metadata text-feedback-error">{member.error}</p> : null}
			{member.worktree ? (
				<div className="flex flex-col gap-4">
					<Button
						variant="outline"
						size="s"
						iconLeft={RiGitBranchLine}
						className="self-start"
						data-testid="swarm-show-diff"
						onClick={() => {
							setFailed(false);
							void readDiff(member.name).then(setDiff, () => setFailed(true));
						}}
					>
						{t("swarm.diff.show", { branch: member.worktree.branch })}
					</Button>
					{failed ? (
						<p role="alert" className="tr-text-metadata text-feedback-error">
							{t("swarm.diff.failed")}
						</p>
					) : null}
					{diff ? <DiffView diff={diff} /> : null}
				</div>
			) : null}
		</div>
	);
}

function Members({
	snapshot,
	readDiff,
}: {
	snapshot: SwarmSnapshot;
	readDiff: (name: string) => Promise<SwarmDiff>;
}) {
	const t = useT();
	const [open, setOpen] = useState<string | null>(null);
	const groups = groupMembers(snapshot.members);
	const sections = [
		["active", t("swarm.members.active")],
		["standing", t("swarm.members.standing")],
		["retired", t("swarm.members.retired")],
	] as const;
	return (
		<div className="max-h-[60vh] overflow-y-auto">
			<p className="px-12 py-8 tr-text-ui text-text-default">{t("swarm.members.coordinator")}</p>
			{sections.map(([id, label]) =>
				groups[id].length ? (
					<section key={id} aria-label={label}>
						<h3 className="px-12 pt-8 tr-text-metadata text-text-muted">
							{label} ({groups[id].length})
						</h3>
						<ul>
							{groups[id].map((member) => (
								<li
									key={member.name}
									data-testid="swarm-member"
									data-status={member.status}
									data-phase={member.phase}
								>
									<button
										type="button"
										className="flex w-full items-start gap-8 px-12 py-8 text-left hover:bg-control-bg-hovered focus-visible:focus-ring-inset"
										aria-expanded={open === member.name}
										onClick={() => setOpen(open === member.name ? null : member.name)}
									>
										<StatusIcon member={member} />
										<span className="min-w-0 flex-1">
											<span className="flex flex-wrap items-baseline gap-x-8">
												<span className="tr-text-emphasis">@{member.name}</span>
												<span className="tr-text-metadata text-text-muted">
													{memberKindLabel(t, member.kind)}
												</span>
												<span className="tr-text-metadata text-text-muted">
													{phaseLabel(t, member.phase)}
												</span>
												{member.model ? (
													<span className="tr-text-metadata text-text-muted">{member.model}</span>
												) : null}
												{member.landed ? (
													<span className="tr-text-metadata text-feedback-success">
														{t("swarm.member.landed")}
													</span>
												) : null}
											</span>
											<span className="block truncate tr-text-metadata text-text-muted">
												{member.activity ??
													(member.lastPost
														? t("swarm.member.lastPost", { seq: member.lastPost })
														: member.brief.task)}
											</span>
										</span>
									</button>
									{open === member.name ? (
										<MemberDetail member={member} readDiff={readDiff} />
									) : null}
								</li>
							))}
						</ul>
					</section>
				) : null,
			)}
		</div>
	);
}

const GRAPH_SIZE = 360;

function Graph({ snapshot }: { snapshot: SwarmSnapshot }) {
	const t = useT();
	const [step, setStep] = useState<number | null>(null);
	const total = snapshot.posts.length;
	const { nodes, links } = layoutGraph(postsUntil(snapshot.posts, step), GRAPH_SIZE);
	return (
		<div className="flex flex-col items-center gap-8">
			<svg
				viewBox={`0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`}
				className="w-full max-w-[360px] text-text-muted"
				role="img"
				aria-label={t("swarm.graph.aria")}
				data-testid="swarm-graph"
			>
				{links.map((link) => (
					<line
						key={`${link.from.name}-${link.to.name}`}
						x1={link.from.x}
						y1={link.from.y}
						x2={link.to.x}
						y2={link.to.y}
						stroke="currentColor"
						strokeWidth={link.weight}
						strokeOpacity={0.5}
					>
						<title>
							{t("swarm.graph.edge", { from: link.from.name, to: link.to.name, count: link.count })}
						</title>
					</line>
				))}
				{nodes.map((node) => (
					<g key={node.name} className="text-text-default">
						<circle cx={node.x} cy={node.y} r={6} fill="currentColor" />
						<text
							x={node.x}
							y={node.y - 10}
							textAnchor="middle"
							fill="currentColor"
							className="tr-text-metadata"
						>
							@{node.name}
						</text>
					</g>
				))}
			</svg>
			<div className="flex items-center gap-8">
				<Button
					variant="ghost"
					size="s"
					disabled={total === 0}
					onClick={() => setStep(Math.max(1, (step ?? total) - 1))}
				>
					{t("swarm.graph.back")}
				</Button>
				<span className="tabular-nums tr-text-metadata text-text-muted">
					{step === null ? t("swarm.graph.live") : t("swarm.graph.step", { step, total })}
				</span>
				<Button
					variant="ghost"
					size="s"
					disabled={step === null}
					onClick={() => setStep(step !== null && step < total ? step + 1 : null)}
				>
					{t("swarm.graph.forward")}
				</Button>
				<Button variant="ghost" size="s" disabled={step === null} onClick={() => setStep(null)}>
					{t("swarm.graph.goLive")}
				</Button>
			</div>
		</div>
	);
}

/** Chat-header trigger and pane for this chat's swarm: the board, its members and the mention graph. */
export function SwarmTrigger({
	workspaceId,
	sessionId,
}: {
	workspaceId: string;
	sessionId: string;
}) {
	const t = useT();
	const { snapshot, readDiff } = useSwarm(workspaceId, sessionId);
	const [tab, setTab] = useState<Tab>("board");
	if (!snapshot) return null;
	const live = liveCount(snapshot);
	return (
		<Dialog>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="m"
					iconLeft={RiTeamLine}
					className={cn("shrink-0", live > 0 && "motion-safe:animate-working")}
					data-testid="swarm-trigger"
					data-live-count={live}
					aria-label={t("swarm.trigger.aria", { count: live })}
				>
					<span className="hidden @[480px]:inline">{t("swarm.trigger.label")}</span>
					<span className="tabular-nums">{live}</span>
				</Button>
			</DialogTrigger>
			<DialogContent className="max-w-[48rem]" data-testid="swarm-pane">
				<DialogTitle>{snapshot.title}</DialogTitle>
				<DialogDescription>
					{snapshot.status === "running" ? t("swarm.status.live") : t("swarm.status.finished")}
					{" · "}
					{snapshot.config.gates.length
						? t("swarm.status.gates", { gates: snapshot.config.gates.join(" · ") })
						: t("swarm.status.noGates")}
				</DialogDescription>
				<div className="flex gap-4">
					<ToggleSegment
						testid="swarm-tab-board"
						label={t("swarm.tabs.board")}
						active={tab === "board"}
						onClick={() => setTab("board")}
					/>
					<ToggleSegment
						testid="swarm-tab-members"
						label={t("swarm.tabs.members")}
						active={tab === "members"}
						onClick={() => setTab("members")}
					/>
					<ToggleSegment
						testid="swarm-tab-graph"
						label={t("swarm.tabs.graph")}
						active={tab === "graph"}
						onClick={() => setTab("graph")}
					/>
				</div>
				{tab === "board" ? <Board snapshot={snapshot} /> : null}
				{tab === "members" ? <Members snapshot={snapshot} readDiff={readDiff} /> : null}
				{tab === "graph" ? <Graph snapshot={snapshot} /> : null}
			</DialogContent>
		</Dialog>
	);
}
