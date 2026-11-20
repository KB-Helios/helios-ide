import type {
	DagStartRequest,
	DagStartResult,
	FactoryRoleName,
	FactoryRolesView,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Switch } from "@thinkrail/ui/switch";
import { Textarea } from "@thinkrail/ui/textarea";
import { ToggleSegment } from "@thinkrail/ui/toggle-segment";
import { useState } from "react";
import {
	effectiveKey,
	modelKey,
	ROLE_ORDER,
	reviewerSharesFamily,
	START_TASK_MAX,
	type StartForm,
	startBlocker,
	startRequest,
} from "./factoryModel";

type T = ReturnType<typeof useT>;

function roleLabel(t: T, role: FactoryRoleName): string {
	return {
		planner: t("factory.start.role.planner"),
		coder: t("factory.start.role.coder"),
		reviewer: t("factory.start.role.reviewer"),
		scout: t("factory.start.role.scout"),
	}[role];
}

/**
 * Starts a factory run: the task, who splits it (a planner whose plan you approve, or one coder) and,
 * optionally, a model per role. A role left on "automatic" is chosen by the host; a reviewer in the
 * coder's vendor family needs an explicit switch and is then recorded in the run. The new DAG is created
 * paused and selected, so the next step is yours: Resume.
 */
export function FactoryStart({
	roles,
	start,
}: {
	roles: () => Promise<FactoryRolesView>;
	start: (request: Omit<DagStartRequest, "workspaceId" | "commandId">) => Promise<DagStartResult>;
}) {
	const t = useT();
	const [view, setView] = useState<FactoryRolesView | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [form, setForm] = useState<StartForm>({
		task: "",
		mode: "plan",
		picks: {},
		allowSameFamily: false,
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = async () => {
		setLoadFailed(false);
		try {
			setView(await roles());
		} catch {
			setLoadFailed(true);
		}
	};
	const pick = (role: FactoryRoleName, key: string) =>
		setForm((current) => ({ ...current, picks: { ...current.picks, [role]: key } }));
	const submit = async () => {
		if (!view) return;
		const request = startRequest(view, form);
		if (!request) return;
		setBusy(true);
		setError(null);
		try {
			await start(request);
			setForm((current) => ({ ...current, task: "", allowSameFamily: false }));
		} catch (failure) {
			setError(failure instanceof Error && failure.message ? failure.message : "");
		}
		setBusy(false);
	};
	const blocker = view ? startBlocker(view, form) : "task";
	const shares = view ? reviewerSharesFamily(view, form) : false;

	return (
		<details
			className="px-12"
			data-testid="factory-start"
			onToggle={(event) => {
				// Reopening after a failed read tries again, so a recovered host can still start a run.
				if (event.currentTarget.open && view === null) void load();
			}}
		>
			<summary className="cursor-pointer py-8 tr-text-emphasis focus-visible:focus-ring-inset">
				{t("factory.start.heading")}
			</summary>
			<div className="flex flex-col gap-8 pb-8">
				<Textarea
					rows={3}
					value={form.task}
					maxLength={START_TASK_MAX}
					onChange={(event) => setForm({ ...form, task: event.target.value })}
					placeholder={t("factory.start.task")}
					aria-label={t("factory.start.task")}
					disabled={busy}
					data-testid="factory-start-task"
				/>
				<div className="flex flex-wrap items-center gap-8">
					<span className="tr-text-metadata text-text-muted">{t("factory.start.mode")}</span>
					<ToggleSegment
						testid="factory-start-mode-plan"
						label={t("factory.start.mode.plan")}
						active={form.mode === "plan"}
						onClick={() => setForm({ ...form, mode: "plan" })}
					/>
					<ToggleSegment
						testid="factory-start-mode-single"
						label={t("factory.start.mode.single")}
						active={form.mode === "single"}
						onClick={() => setForm({ ...form, mode: "single" })}
					/>
				</div>
				<p className="tr-text-metadata text-text-muted">
					{form.mode === "plan"
						? t("factory.start.mode.planHint")
						: t("factory.start.mode.singleHint")}
				</p>
				{loadFailed ? (
					<span role="alert" className="tr-text-metadata text-feedback-error">
						{t("factory.start.rolesError")}
					</span>
				) : null}
				{view ? (
					<div className="grid grid-cols-[auto_1fr] items-center gap-x-8 gap-y-4">
						{ROLE_ORDER.filter((role) => role !== "planner" || form.mode === "plan").map((role) => (
							<label key={role} className="contents">
								<span className="tr-text-metadata text-text-muted">{roleLabel(t, role)}</span>
								<select
									value={form.picks[role] ?? ""}
									onChange={(event) => pick(role, event.target.value)}
									disabled={busy}
									aria-label={roleLabel(t, role)}
									className="min-w-0 rounded-md border border-border-default bg-control-bg px-8 py-4 tr-text-ui"
									data-testid={`factory-start-${role}`}
								>
									<option value="">
										{role === "reviewer" &&
										form.picks.coder &&
										form.picks.coder !== modelKey(view.defaults.coder)
											? t("factory.start.automaticOtherFamily")
											: t("factory.start.automatic", { model: effectiveKeyName(view, role) })}
									</option>
									{view.models.map((model) => (
										<option key={modelKey(model)} value={modelKey(model)}>
											{model.name === model.id
												? modelKey(model)
												: `${model.name} (${modelKey(model)})`}
										</option>
									))}
								</select>
							</label>
						))}
					</div>
				) : null}
				{shares ? (
					<div className="flex items-start gap-8" data-testid="factory-start-same-family">
						<Switch
							checked={form.allowSameFamily}
							label={t("factory.start.sameFamily")}
							onCheckedChange={(checked) => setForm({ ...form, allowSameFamily: checked })}
						/>
						<span className="tr-text-metadata text-feedback-warning">
							{t("factory.start.sameFamily")}
						</span>
					</div>
				) : null}
				{error !== null ? (
					<span role="alert" className="tr-text-metadata text-feedback-error wrap-anywhere">
						{error || t("factory.error.rejected")}
					</span>
				) : null}
				<div>
					<Button
						variant="primary"
						size="m"
						disabled={busy || !view || blocker !== null}
						onClick={() => void submit()}
						data-testid="factory-start-submit"
					>
						{t("factory.start.submit")}
					</Button>
				</div>
			</div>
		</details>
	);
}

/** The model a role would use by default, for the "Automatic" option's label. */
function effectiveKeyName(view: FactoryRolesView, role: FactoryRoleName): string {
	return effectiveKey(view, { picks: {} }, role);
}
