import { RiPlayLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Switch } from "@thinkrail/ui/switch";
import { useAppStore } from "../store";

/** Follow Agent's two controls in a file's toolbar: the switch, and the pill that ends a pause. */
export function FollowAgentControls({ workspaceId }: { workspaceId: string }) {
	const t = useT();
	const follow = useAppStore((state) => state.followAgent);
	const paused = useAppStore((state) => state.followPausedByWorkspace[workspaceId] === true);
	return (
		<>
			{follow && paused ? (
				<Button
					variant="soft-primary"
					size="s"
					iconLeft={RiPlayLine}
					data-testid="follow-resume"
					onClick={() => useAppStore.getState().resumeFollow(workspaceId)}
				>
					{t("panels.filePane.followResume")}
				</Button>
			) : null}
			<span className="flex items-center gap-4 text-text-muted tr-text-metadata">
				{t("panels.filePane.followAgent")}
				<Switch
					checked={follow}
					label={t("panels.filePane.followAgent")}
					testId="follow-agent"
					onCheckedChange={(on) => useAppStore.getState().setFollowAgent(on)}
				/>
			</span>
		</>
	);
}
