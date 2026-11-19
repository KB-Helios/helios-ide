import {
	languageFromPath,
	resultText,
	strArg,
	type ToolRenderProps,
} from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { CodeBlock } from "./CodeBlock";
import { Collapsible, countLines } from "./Collapsible";
import { FileChangeCard } from "./FileChangeCard";

export function WriteCard({
	toolCallId,
	args,
	result,
	status,
	workspaceRoot,
	onOpenFile,
}: ToolRenderProps) {
	const t = useT();
	const path = strArg(args, "path");
	const content = strArg(args, "content");

	return (
		<FileChangeCard
			toolCallId={toolCallId}
			testId="tool-write"
			path={path}
			workspaceRoot={workspaceRoot}
			onOpenFile={onOpenFile}
			status={status}
			added={countLines(content)}
			removed={0}
			verb={t("tools.write.written")}
		>
			{status === "error" ? (
				<pre className="overflow-auto px-8 py-4 text-feedback-error tr-code-text">
					{resultText(result)}
				</pre>
			) : content ? (
				<Collapsible id={`${toolCallId}:content`} lines={countLines(content)}>
					<CodeBlock code={content} lang={languageFromPath(path)} />
				</Collapsible>
			) : (
				<span className="text-text-muted tr-text-metadata italic">
					{t("tools.write.emptyFile")}
				</span>
			)}
		</FileChangeCard>
	);
}
