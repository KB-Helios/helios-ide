import {
	RiCheckLine as Check,
	RiFocusLine,
	RiLayoutColumnFill,
	RiLayoutColumnLine,
	RiLayoutRightLine,
} from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@thinkrail/ui/dropdown-menu";
import { useState } from "react";
import { useAppStore } from "../store";
import { useKeybindingLabel } from "./keybindingState";
import { BUILTIN_LAYOUT_PRESETS, layoutPresetName, resolveLayoutPreset } from "./layout";
import {
	applyWorkflowLayoutPreset,
	LAYOUT_MENU_ITEMS,
	type LayoutMenuItem,
	useAppliedLayoutPresetId,
} from "./layoutPresetActions";

const ITEM_ICONS: Readonly<Record<LayoutMenuItem["id"], typeof Check>> = {
	"agent-split": RiLayoutColumnLine,
	"code-focus": RiFocusLine,
	"review-mode": RiLayoutRightLine,
};

function LayoutPresetItem({ item, applied }: { item: LayoutMenuItem; applied: boolean }) {
	const t = useT();
	const shortcut = useKeybindingLabel(item.binding);
	const Icon = ITEM_ICONS[item.id];
	return (
		<DropdownMenuItem
			data-testid={`layout-preset-${item.id}`}
			data-applied={applied}
			onSelect={() => applyWorkflowLayoutPreset(t, item.id)}
		>
			<Icon />
			{layoutPresetName(t, resolveLayoutPreset(item.id, []))}
			{shortcut ? (
				<span className="ml-auto text-text-subtle tr-text-metadata">{shortcut}</span>
			) : null}
			<Check className={applied ? "" : "invisible"} />
		</DropdownMenuItem>
	);
}

/**
 * The topbar's layout switcher: the three workflow presets as one menu, the applied one checked. It
 * only arranges the shell's frame; the command palette and the `layout.*` chords reach the same
 * `applyWorkflowLayoutPreset`.
 */
export function LayoutPresetMenu() {
	const t = useT();
	const [open, setOpen] = useState(false);
	const frameReady = useAppStore((state) => state.workbenchFrame !== null);
	const appliedId = useAppliedLayoutPresetId(BUILTIN_LAYOUT_PRESETS);
	const workflowApplied = LAYOUT_MENU_ITEMS.some((item) => item.id === appliedId);
	return (
		<DropdownMenu open={open} onOpenChange={setOpen}>
			<DropdownMenuTrigger asChild>
				<IconButton
					variant="ghost"
					size="m"
					icon={workflowApplied ? RiLayoutColumnFill : RiLayoutColumnLine}
					label={t("shell.topbar.layout")}
					tooltip={t("shell.topbar.layout")}
					selected={open}
					disabled={!frameReady}
					data-testid="layout-preset-menu"
					className="max-sm:hidden"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{LAYOUT_MENU_ITEMS.map((item) => (
					<LayoutPresetItem key={item.id} item={item} applied={item.id === appliedId} />
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
