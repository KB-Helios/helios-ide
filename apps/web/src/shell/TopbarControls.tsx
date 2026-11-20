import {
	RiFileEditLine,
	RiLayoutRightFill,
	RiLayoutRightLine,
	RiSideBarFill,
	RiSideBarLine,
	RiTerminalBoxFill,
	RiTerminalBoxLine,
} from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import { useAgentChanges } from "../panels/useAgentChanges";
import { useGitStatus } from "../panels/useGitStatus";
import { useAppStore } from "../store";
import { useKeybindingLabel } from "./keybindingState";

/**
 * The Codex-style top bar's leading control: one toggle for the Thread Sidebar (the Projects tool in a
 * workspace, the Projects pane on Project Home). It is a component, not inline header JSX, so the
 * header's own action cluster keeps owning the no-drag boundary; its root opts out of dragging itself.
 */
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	const t = useT();
	const shortcut = useKeybindingLabel("view.toggleLeft");
	const label = open ? t("shell.topbar.hideSidebar") : t("shell.topbar.showSidebar");
	return (
		<div className="window-no-drag flex shrink-0 items-center">
			<IconButton
				variant="ghost"
				size="m"
				icon={open ? RiSideBarFill : RiSideBarLine}
				label={label}
				tooltip={label}
				tooltipShortcut={shortcut ? [shortcut] : undefined}
				selected={open}
				aria-pressed={open}
				data-testid="toggle-sidebar"
				onClick={onToggle}
			/>
		</div>
	);
}

function useSideVisible(side: "right" | "bottom"): boolean {
	return useAppStore((s) => {
		const frame = s.workbenchFrame?.[side];
		return (frame?.visible && frame.groups.some((group) => !group.folded)) ?? false;
	});
}

interface ReviewSummary {
	/** Sum of the changed lines, or `null` while unknown / for a chat. */
	totals: { added: number; removed: number } | null;
	/** How many of the scope's changed files an agent run touched. */
	agentFiles: number;
}

/** One `git.status` read feeds both the line totals and the agent-touched file count. */
function useReviewSummary(workspaceId: string | null): ReviewSummary {
	const { status } = useGitStatus(workspaceId);
	const agentFiles = useAgentChanges(workspaceId, status?.changes).length;
	if (!status) return { totals: null, agentFiles };
	let added = 0;
	let removed = 0;
	for (const change of status.changes) {
		added += change.added ?? 0;
		removed += change.removed ?? 0;
	}
	return { totals: { added, removed }, agentFiles };
}

/**
 * The "N files changed" pill: how many of the changed files an agent run touched. Clicking it only reveals
 * (the Files tool in Changed mode, narrowed to those files), so it never closes the side Review Changes owns.
 */
function AgentChangesPill({ workspaceId, count }: { workspaceId: string; count: number }) {
	const t = useT();
	return (
		<Button
			variant="soft-primary"
			size="m"
			iconLeft={RiFileEditLine}
			tooltip={t("shell.topbar.agentFilesReview")}
			className="max-sm:hidden"
			data-testid="agent-changes-pill"
			data-count={count}
			onClick={() => useAppStore.getState().revealAgentChanges(workspaceId)}
		>
			<span className="tabular-nums">{t("shell.topbar.agentFiles", { count })}</span>
		</Button>
	);
}

/**
 * Review Changes: opens the right side on the Review tool, or hides the right side when it is shown.
 * It carries the workspace's `+N −M` line totals when git status is known, and is preceded by the
 * agent files pill while an agent run's changes are still in the scope.
 */
export function ReviewChangesButton({
	workspaceId,
	gitWorkspaceId,
	onToggle,
}: {
	workspaceId: string;
	/** `null` for a chat without a project: no git status to read. */
	gitWorkspaceId: string | null;
	onToggle: () => void;
}) {
	const t = useT();
	const open = useSideVisible("right");
	const shortcut = useKeybindingLabel("view.toggleRight");
	const { totals, agentFiles } = useReviewSummary(gitWorkspaceId);
	const hasChanges = totals !== null && (totals.added > 0 || totals.removed > 0);
	const label = open ? t("shell.topbar.hideReview") : t("shell.topbar.openReview");
	return (
		<>
			{agentFiles > 0 ? <AgentChangesPill workspaceId={workspaceId} count={agentFiles} /> : null}
			<Button
				variant="ghost"
				size="m"
				iconLeft={open ? RiLayoutRightFill : RiLayoutRightLine}
				selected={open}
				aria-pressed={open}
				aria-label={label}
				tooltip={label}
				tooltipShortcut={shortcut ? [shortcut] : undefined}
				className="max-sm:hidden"
				data-testid="open-review"
				data-workspace-id={workspaceId}
				onClick={onToggle}
			>
				{hasChanges ? (
					<span className="tabular-nums">
						<span className="text-feedback-success">+{totals.added}</span>{" "}
						<span className="text-feedback-error">−{totals.removed}</span>
					</span>
				) : (
					t("shell.topbar.review")
				)}
			</Button>
		</>
	);
}

/** Terminal toggle: shows or hides the bottom panel, where the workspace's terminals live. */
export function TerminalToggle({ onToggle }: { onToggle: () => void }) {
	const t = useT();
	const open = useSideVisible("bottom");
	const shortcut = useKeybindingLabel("view.toggleBottom");
	const label = open ? t("shell.topbar.hideTerminal") : t("shell.topbar.showTerminal");
	return (
		<IconButton
			variant="ghost"
			size="m"
			icon={open ? RiTerminalBoxFill : RiTerminalBoxLine}
			label={label}
			tooltip={label}
			tooltipShortcut={shortcut ? [shortcut] : undefined}
			selected={open}
			aria-pressed={open}
			data-testid="toggle-terminal"
			className="max-sm:hidden"
			onClick={onToggle}
		/>
	);
}
