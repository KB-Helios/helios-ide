import type { ToolStatus } from "@thinkrail/extension-api/web";
import type { ChatTurn, ToolResultState } from "../chat/types";
import type { LayoutCenterGroup } from "./layout";

export type FileMutationKind = "edit" | "write";

export interface FileMutation {
	readonly toolCallId: string;
	readonly kind: FileMutationKind;
	readonly path: string;
	/** The text the edit put in the file; empty for a write, which reveals line 1. */
	readonly newText: string;
}

const NEW_TEXT_KEYS = ["newText", "new_string", "new"] as const;

function stringArg(args: unknown, key: string): string {
	if (typeof args !== "object" || args === null) return "";
	const value: unknown = Reflect.get(args, key);
	return typeof value === "string" ? value : "";
}

function isSettled(status: ToolStatus | undefined): boolean {
	return status === "done";
}

/** Settled `edit` / `write` calls in `turns` that `seen` does not hold yet, oldest first. */
export function newFileMutations(
	turns: readonly ChatTurn[],
	toolResults: Readonly<Record<string, ToolResultState>>,
	seen: ReadonlySet<string>,
): FileMutation[] {
	const found: FileMutation[] = [];
	for (const turn of turns) {
		if (turn.kind !== "assistant") continue;
		for (const block of turn.message.content) {
			if (block.type !== "toolCall" || seen.has(block.id)) continue;
			if (block.name !== "edit" && block.name !== "write") continue;
			if (!isSettled(toolResults[block.id]?.status)) continue;
			const path = stringArg(block.arguments, "path");
			if (!path) continue;
			const newText =
				block.name === "write"
					? ""
					: (NEW_TEXT_KEYS.map((key) => stringArg(block.arguments, key)).find(Boolean) ?? "");
			found.push({ toolCallId: block.id, kind: block.name, path, newText });
		}
	}
	return found;
}

/** The 1-based line the mutation starts at in `content`, or `1` when it cannot be found. */
export function changedLine(
	content: string,
	mutation: Pick<FileMutation, "kind" | "newText">,
): number {
	if (mutation.kind === "write") return 1;
	const text = mutation.newText.trimStart();
	const at = text ? content.indexOf(text) : -1;
	if (at < 0) return 1;
	let line = 1;
	for (let i = 0; i < at; i += 1) if (content.charCodeAt(i) === 10) line += 1;
	return line;
}

/**
 * The center group the followed file should open in: one that does not hold the running chat, preferring
 * a group already showing a file. `undefined` leaves the choice to the layout (a single-group layout).
 */
export function followTargetGroupId(
	groups: readonly LayoutCenterGroup[],
	chatTabId: string,
): string | undefined {
	const others = groups.filter((group) => !group.tabs.some((tab) => tab.id === chatTabId));
	return (others.find((group) => group.tabs.some((tab) => tab.kind === "file")) ?? others[0])?.id;
}
