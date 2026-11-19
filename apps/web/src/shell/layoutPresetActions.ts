import type { LayoutPreset } from "@thinkrail/contracts";
import type { Translator } from "@thinkrail/locales/react";
import { useMemo } from "react";
import type { KeybindingId } from "../keybindings";
import { toast, useAppStore } from "../store";
import { errorText } from "../transport";
import {
	frameMatchesPreset,
	layoutPresetName,
	resolveLayoutPreset,
	type WorkflowLayoutPresetId,
} from "./layout";
import { applyLayoutPresetLocally } from "./layoutState";

export type LayoutBinding = "layout.agentSplit" | "layout.codeFocus" | "layout.reviewMode";

export interface LayoutMenuItem {
	readonly id: WorkflowLayoutPresetId;
	readonly binding: LayoutBinding;
}

/** The workflow presets in menu order, each with the keybinding that applies it. */
export const LAYOUT_MENU_ITEMS: readonly LayoutMenuItem[] = [
	{ id: "agent-split", binding: "layout.agentSplit" },
	{ id: "code-focus", binding: "layout.codeFocus" },
	{ id: "review-mode", binding: "layout.reviewMode" },
];

/** Applies `preset` to the local frame and tells the user, or why it could not be. */
export function applyLayoutPreset(t: Translator, preset: LayoutPreset): void {
	try {
		applyLayoutPresetLocally(preset);
		toast.success(t("workbench.layoutSettings.applied", { name: layoutPresetName(t, preset) }));
	} catch (error) {
		toast.error(errorText(error), t("workbench.layoutSettings.applyFailed"));
	}
}

export function applyWorkflowLayoutPreset(t: Translator, id: WorkflowLayoutPresetId): void {
	applyLayoutPreset(t, resolveLayoutPreset(id, []));
}

/** The chord handler: applies the preset the pressed `layout.*` binding names. */
export function applyLayoutBinding(t: Translator, binding: KeybindingId): void {
	const item = LAYOUT_MENU_ITEMS.find((candidate) => candidate.binding === binding);
	if (item) applyWorkflowLayoutPreset(t, item.id);
}

/** The id of the first of `presets` the live frame exactly matches, or `null` once it was edited. */
export function useAppliedLayoutPresetId(presets: readonly LayoutPreset[]): string | null {
	const frame = useAppStore((state) => state.workbenchFrame);
	return useMemo(
		() =>
			frame ? (presets.find((preset) => frameMatchesPreset(frame, preset))?.id ?? null) : null,
		[frame, presets],
	);
}
