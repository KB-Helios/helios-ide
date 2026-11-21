import type { DagWireCommand } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useState } from "react";
import type { NodeAction } from "./factoryModel";
import type { FactoryFailure } from "./useFactory";

export type RunCommand = (command: DagWireCommand) => Promise<FactoryFailure | null>;

/**
 * A control that changes running work. Retry discards what the node and everything after it produced,
 * cancel stops work and interrupt holds it, so each asks once more: the first press arms the button, the
 * second sends the command, and leaving the button disarms it.
 */
export function ConfirmButton({
	label,
	confirmLabel,
	onConfirm,
	disabled,
	testId,
}: {
	label: string;
	confirmLabel: string;
	onConfirm: () => void;
	disabled?: boolean;
	testId: string;
}) {
	const [armed, setArmed] = useState(false);
	return (
		<Button
			variant={armed ? "primary" : "outline"}
			size="m"
			disabled={disabled}
			onBlur={() => setArmed(false)}
			onClick={() => {
				if (!armed) return setArmed(true);
				setArmed(false);
				onConfirm();
			}}
			data-testid={testId}
			data-armed={armed}
		>
			{armed ? confirmLabel : label}
		</Button>
	);
}

/** The node's retry / continue / cancel controls; the host re-checks every command. */
export function NodeActions({
	actions,
	send,
	disabled,
}: {
	actions: readonly NodeAction[];
	send: (action: NodeAction) => void;
	disabled: boolean;
}) {
	const t = useT();
	if (actions.length === 0) return null;
	const labels = {
		continue: t("factory.action.continue"),
		retry: t("factory.action.retry"),
		cancel: t("factory.action.cancel"),
	};
	return (
		<span className="mt-4 flex flex-wrap gap-8" data-testid="factory-node-actions">
			{actions.map((action) =>
				action === "continue" ? (
					<Button
						key={action}
						variant="outline"
						size="m"
						disabled={disabled}
						onClick={() => send(action)}
						data-testid={`factory-node-${action}`}
					>
						{labels[action]}
					</Button>
				) : (
					<ConfirmButton
						key={action}
						label={labels[action]}
						confirmLabel={t("factory.action.confirm", { action: labels[action] })}
						disabled={disabled}
						onConfirm={() => send(action)}
						testId={`factory-node-${action}`}
					/>
				),
			)}
		</span>
	);
}
