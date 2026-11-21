import { RiAddLine, RiDeleteBinLine } from "@remixicon/react";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { Textarea } from "@thinkrail/ui/textarea";
import { useEffect, useRef, useState } from "react";
import {
	type CoderDraft,
	type CoderIssue,
	type CoderIssueCode,
	MAX_CODER_TASK,
	MAX_PLAN_CODERS,
	newCoder,
} from "./coderPlan";

type T = ReturnType<typeof useT>;

const FIELD =
	"min-w-0 rounded-md border border-border-default bg-control-bg px-8 py-4 tr-text-ui focus-visible:focus-ring";

function issueText(t: T, issue: CoderIssue): string {
	const text: Record<CoderIssueCode, string> = {
		"id-invalid": t("factory.start.issue.idInvalid"),
		"id-reserved": t("factory.start.issue.idReserved"),
		"id-duplicate": t("factory.start.issue.idDuplicate"),
		"task-missing": t("factory.start.issue.taskMissing"),
		"task-long": t("factory.start.issue.taskLong", { max: MAX_CODER_TASK }),
		"owns-required": t("factory.start.issue.ownsRequired"),
		"owns-invalid": t("factory.start.issue.ownsInvalid"),
		"avoid-invalid": t("factory.start.issue.avoidInvalid"),
		overlap: t("factory.start.issue.overlap", { other: issue.other ?? "" }),
	};
	return text[issue.code];
}

/**
 * The coders of a run you list yourself: an id, a task, `owns` globs and optional `avoid` globs per row, up
 * to the host's limit. A row's problems appear once you touched it, so a fresh row is not an error wall;
 * the host's own refusal still shows if it disagrees.
 */
export function CoderRows({
	coders,
	issues,
	disabled,
	onChange,
}: {
	coders: CoderDraft[];
	issues: readonly CoderIssue[];
	disabled: boolean;
	onChange: (coders: CoderDraft[]) => void;
}) {
	const t = useT();
	const counter = useRef(coders.length);
	const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
	const [focusKey, setFocusKey] = useState<string | null>(null);

	const listRef = useRef<HTMLDivElement>(null);
	// A row you just added takes keyboard focus on its id, so adding by keyboard continues in the new row.
	useEffect(() => {
		if (focusKey === null) return;
		const row = [
			...(listRef.current?.querySelectorAll<HTMLElement>("[data-coder-key]") ?? []),
		].find((element) => element.dataset.coderKey === focusKey);
		row?.querySelector<HTMLInputElement>("input")?.focus();
		setFocusKey(null);
	}, [focusKey]);

	const patch = (key: string, change: Partial<CoderDraft>) => {
		setTouched((current) => new Set(current).add(key));
		onChange(coders.map((coder) => (coder.key === key ? { ...coder, ...change } : coder)));
	};
	const add = () => {
		counter.current += 1;
		const used = new Set(coders.map((coder) => coder.id));
		let n = coders.length + 1;
		while (used.has(`coder-${n}`)) n += 1;
		const row = newCoder(`coder-row-${counter.current}`, `coder-${n}`);
		setFocusKey(row.key);
		onChange([...coders, row]);
	};
	const remove = (index: number) => {
		onChange(coders.filter((_, position) => position !== index));
	};

	return (
		<div ref={listRef} className="flex flex-col gap-8" data-testid="factory-start-coders">
			{coders.map((coder, index) => {
				const rowIssues = touched.has(coder.key)
					? issues.filter((issue) => issue.key === coder.key)
					: [];
				const label = t("factory.start.coder.heading", { index: index + 1 });
				const errorId = `factory-coder-${coder.key}-error`;
				return (
					<fieldset
						key={coder.key}
						aria-label={label}
						className="flex min-w-0 flex-col gap-4 rounded-md border border-border-default p-8"
						data-coder-key={coder.key}
						data-testid="factory-start-coder"
					>
						<div className="flex items-center gap-8">
							<span className="tr-text-metadata text-text-muted">{label}</span>
							<input
								value={coder.id}
								onChange={(event) => patch(coder.key, { id: event.target.value })}
								disabled={disabled}
								maxLength={32}
								aria-label={t("factory.start.coder.id")}
								aria-invalid={rowIssues.length > 0 || undefined}
								aria-describedby={rowIssues.length > 0 ? errorId : undefined}
								className={`${FIELD} w-160`}
								data-testid="factory-start-coder-id"
							/>
							<Button
								variant="ghost"
								size="s"
								iconLeft={RiDeleteBinLine}
								disabled={disabled || coders.length <= 1}
								aria-label={t("factory.start.coder.remove", { index: index + 1 })}
								onClick={() => remove(index)}
								data-testid="factory-start-coder-remove"
							>
								{t("factory.start.coder.removeLabel")}
							</Button>
						</div>
						<Textarea
							rows={2}
							value={coder.task}
							maxLength={MAX_CODER_TASK}
							onChange={(event) => patch(coder.key, { task: event.target.value })}
							placeholder={t(
								coders.length === 1
									? "factory.start.coder.taskSolePlaceholder"
									: "factory.start.coder.task",
							)}
							aria-label={t("factory.start.coder.task")}
							disabled={disabled}
							data-testid="factory-start-coder-task"
						/>
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<Textarea
								rows={2}
								value={coder.owns}
								onChange={(event) => patch(coder.key, { owns: event.target.value })}
								placeholder={t("factory.start.coder.owns")}
								aria-label={t("factory.start.coder.owns")}
								disabled={disabled}
								data-testid="factory-start-coder-owns"
							/>
							<Textarea
								rows={2}
								value={coder.avoid}
								onChange={(event) => patch(coder.key, { avoid: event.target.value })}
								placeholder={t("factory.start.coder.avoid")}
								aria-label={t("factory.start.coder.avoid")}
								disabled={disabled}
								data-testid="factory-start-coder-avoid"
							/>
						</div>
						{rowIssues.length > 0 ? (
							<ul
								id={errorId}
								role="alert"
								className="tr-text-metadata text-feedback-error"
								data-testid="factory-start-coder-issues"
							>
								{rowIssues.map((issue) => (
									<li key={issue.code}>{issueText(t, issue)}</li>
								))}
							</ul>
						) : null}
					</fieldset>
				);
			})}
			<div className="flex items-center gap-8">
				<Button
					variant="outline"
					size="s"
					iconLeft={RiAddLine}
					disabled={disabled || coders.length >= MAX_PLAN_CODERS}
					onClick={add}
					data-testid="factory-start-coder-add"
				>
					{t("factory.start.coder.add")}
				</Button>
				<span className="tr-text-metadata text-text-muted">
					{t("factory.start.coder.count", { count: coders.length, max: MAX_PLAN_CODERS })}
				</span>
			</div>
		</div>
	);
}
