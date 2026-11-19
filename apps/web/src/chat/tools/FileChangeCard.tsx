import {
	RiArrowRightSLine as ChevronRight,
	RiFileLine as FileIcon,
	RiLayoutRightLine as Inspector,
} from "@remixicon/react";
import type { ToolStatus } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";
import { cn } from "@thinkrail/ui/utils";
import { motion, useReducedMotion } from "framer-motion";
import { type ReactNode, useState } from "react";
import { projectRelativePath } from "@/lib";
import { CONTENT_WIDTH_BREAKOUT } from "../contentWidth";
import { workspaceFileTarget } from "../fileTargets";
import { useFold } from "../foldState";
import { ToolFileLink } from "./ToolFileLink";

/**
 * The inline frame of a file mutation (`edit`, `write`). It owns the header — file icon, workspace-relative
 * path, `+N −M` counters and the Open in Inspector action — and the spring-eased body; the tool's own
 * renderer supplies the counters and the body. Props-driven: `onOpenFile` is the only way out.
 */
export function FileChangeCard({
	toolCallId,
	testId,
	path,
	workspaceRoot,
	onOpenFile,
	status,
	added,
	removed,
	verb,
	children,
}: {
	toolCallId: string;
	testId: string;
	path: string;
	workspaceRoot?: string | undefined;
	onOpenFile?: ((path: string) => void) | undefined;
	status: ToolStatus;
	added: number;
	removed: number;
	verb: string;
	children: ReactNode;
}) {
	const t = useT();
	const reduceMotion = useReducedMotion();
	const [expanded, toggle, toggleRef] = useFold(toolCallId, true);
	const [animateOpen, setAnimateOpen] = useState(false);
	const settled = status === "done";
	const inspectorTarget = settled ? workspaceFileTarget(path, workspaceRoot) : null;
	const displayPath = projectRelativePath(path.trim(), workspaceRoot);
	return (
		<div
			data-testid={testId}
			data-chat-fold-root
			data-status={status}
			data-expanded={expanded}
			className={cn(
				"rounded-lg border border-border-muted bg-container-elevated-bg",
				CONTENT_WIDTH_BREAKOUT,
			)}
		>
			<div className="flex items-center gap-4 px-8 py-4">
				<button
					ref={toggleRef}
					type="button"
					data-testid="file-change-toggle"
					data-chat-item-toggle
					aria-expanded={expanded}
					aria-label={t("tools.fileChange.toggle", { path: displayPath })}
					onClick={(event) => {
						setAnimateOpen(true);
						toggle(event);
					}}
					className="flex shrink-0 cursor-pointer items-center gap-2 rounded-sm text-text-muted hover:text-text-default focus-visible:focus-ring"
				>
					<ChevronRight
						className={cn("size-16 shrink-0 transition-transform", expanded && "rotate-90")}
					/>
					<FileIcon className="size-14 shrink-0" />
				</button>
				<ToolFileLink
					path={path}
					workspaceRoot={workspaceRoot}
					onOpenFile={onOpenFile}
					disabled={!settled}
					className="text-text-default tr-code-path"
				/>
				<span className="shrink-0 text-text-muted tr-text-metadata">{verb}</span>
				<span
					role="img"
					data-testid="file-change-stats"
					aria-label={t("tools.fileChange.stats", { added, removed })}
					className="ml-auto flex shrink-0 gap-6 tabular-nums tr-code-path"
				>
					{added > 0 ? <span className="text-feedback-success">+{added}</span> : null}
					{removed > 0 ? <span className="text-feedback-error">−{removed}</span> : null}
				</span>
				{onOpenFile ? (
					<IconButton
						variant="ghost"
						size="s"
						icon={Inspector}
						label={t("tools.fileChange.openInspector")}
						tooltip={t("tools.fileChange.openInspector")}
						disabled={inspectorTarget === null}
						data-testid="file-change-open"
						onClick={() => {
							if (inspectorTarget) onOpenFile(inspectorTarget);
						}}
					/>
				) : null}
			</div>
			{expanded ? (
				<motion.div
					data-testid="file-change-body"
					initial={animateOpen && !reduceMotion ? { opacity: 0, y: -4 } : false}
					animate={{ opacity: 1, y: 0 }}
					transition={{ type: "spring", stiffness: 520, damping: 40, mass: 0.6 }}
					className={cn("px-8 pb-8", status === "error" && "text-feedback-error")}
				>
					{children}
				</motion.div>
			) : null}
		</div>
	);
}
