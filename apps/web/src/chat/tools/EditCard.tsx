import { resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { Collapsible, countLines } from "./Collapsible";
import { FileChangeCard } from "./FileChangeCard";

export function EditCard({
	toolCallId,
	args,
	result,
	status,
	workspaceRoot,
	onOpenFile,
}: ToolRenderProps) {
	const t = useT();
	const path = strArg(args, "path");
	const oldText = strArg(args, "oldText") || strArg(args, "old_string") || strArg(args, "old");
	const newText = strArg(args, "newText") || strArg(args, "new_string") || strArg(args, "new");
	const oldLines = oldText ? oldText.split("\n") : [];
	const newLines = newText ? newText.split("\n") : [];

	return (
		<FileChangeCard
			toolCallId={toolCallId}
			testId="tool-edit"
			path={path}
			workspaceRoot={workspaceRoot}
			onOpenFile={onOpenFile}
			status={status}
			added={countLines(newText)}
			removed={countLines(oldText)}
			verb={t("tools.edit.edited")}
		>
			{status === "error" ? (
				<pre className="overflow-auto px-8 py-4 text-feedback-error tr-code-text">
					{resultText(result)}
				</pre>
			) : (
				<Collapsible
					id={`${toolCallId}:content`}
					lines={oldLines.length + newLines.length}
					fadeClass="bg-[linear-gradient(to_top,var(--container-elevated-bg),transparent)]"
				>
					<div className="overflow-auto rounded-sm border border-border-default tr-code-text leading-relaxed">
						{oldLines.map((line, i) => {
							const key = `old-${i}`;
							return (
								<div key={key} className="flex bg-feedback-error-subtle">
									<span className="w-24 shrink-0 select-none px-4 text-right text-feedback-error-muted">
										−
									</span>
									<pre className="min-w-0 flex-1 px-4 text-feedback-error tr-code-text">{line}</pre>
								</div>
							);
						})}
						{newLines.map((line, i) => {
							const key = `new-${i}`;
							return (
								<div key={key} className="flex bg-feedback-success-subtle">
									<span className="w-24 shrink-0 select-none px-4 text-right text-feedback-success-muted">
										+
									</span>
									<pre className="min-w-0 flex-1 px-4 text-feedback-success tr-code-text">
										{line}
									</pre>
								</div>
							);
						})}
					</div>
				</Collapsible>
			)}
		</FileChangeCard>
	);
}
