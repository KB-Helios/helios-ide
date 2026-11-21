import {
	FACTORY_CAP_PROTOCOL_VERSION,
	FACTORY_MAX_CONCURRENT,
	isFactoryMaxConcurrent,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { SETTINGS_INPUT, useSettingsDraft } from "./settingsDraft";

/** The whole number a draft spells inside `FACTORY_MAX_CONCURRENT`, else `null`; never clamps. */
export function parseFactoryCap(draft: string): number | null {
	if (!/^\d+$/.test(draft)) return null;
	const value = Number(draft);
	return isFactoryMaxConcurrent(value) ? value : null;
}

function CapField({ saved, onCommit }: { saved: number; onCommit: (value: number) => void }) {
	const t = useT();
	const { invalid, inputProps } = useSettingsDraft({
		saved: String(saved),
		isValid: (draft) => parseFactoryCap(draft) !== null,
		commit: (draft) => {
			const value = parseFactoryCap(draft);
			if (value !== null) onCommit(value);
			return undefined;
		},
	});
	const errorId = "factory-cap-error";
	return (
		<span className="flex flex-col items-end gap-2">
			<input
				type="number"
				min={FACTORY_MAX_CONCURRENT.min}
				max={FACTORY_MAX_CONCURRENT.max}
				step={1}
				inputMode="numeric"
				{...inputProps}
				aria-label={t("settings.factory.capLabel")}
				aria-describedby={invalid ? errorId : undefined}
				data-testid="factory-cap-input"
				className={cn(SETTINGS_INPUT, "w-64 text-right")}
			/>
			{invalid ? (
				<span id={errorId} className="text-feedback-error tr-text-metadata">
					{t("settings.factory.capRange", {
						min: FACTORY_MAX_CONCURRENT.min,
						max: FACTORY_MAX_CONCURRENT.max,
					})}
				</span>
			) : null}
		</span>
	);
}

/**
 * Settings → Chat → Factory: the machine-wide cap on factory worker turns (`AppConfig.factoryMaxConcurrent`),
 * applied live by the host. Offered only to a host that stores it, so an independently shipped client never
 * sends an update an older host would reject.
 */
export function FactorySettings({
	protocolVersion,
	value,
	onChange,
}: {
	protocolVersion: number | null;
	value: number;
	onChange: (value: number) => void;
}) {
	const t = useT();
	if (protocolVersion === null || protocolVersion < FACTORY_CAP_PROTOCOL_VERSION) return null;
	return (
		<SettingsGroup
			testId="settings-factory"
			title={t("settings.factory.title")}
			description={t("settings.factory.description")}
		>
			<SettingsRow
				label={t("settings.factory.cap")}
				description={t("settings.factory.capDescription")}
				control={<CapField saved={value} onCommit={onChange} />}
			/>
		</SettingsGroup>
	);
}
