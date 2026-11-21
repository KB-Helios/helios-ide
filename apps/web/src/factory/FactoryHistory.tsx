import {
	DAG_OUTPUT_MAX_BYTES,
	type DagHistoryItem,
	type DagHistoryPage,
	type DagOutputView,
} from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useRef, useState } from "react";
import { artifactImageSrc, historyTarget } from "./factoryModel";

type T = ReturnType<typeof useT>;

function actorLabel(t: T, actor: NonNullable<DagHistoryItem["actor"]>): string {
	return {
		human: t("factory.history.actor.human"),
		controller: t("factory.history.actor.controller"),
		owner: t("factory.history.actor.owner"),
	}[actor];
}

/**
 * The DAG's event history, read on demand in pages from the host (oldest first). It is a manifest: what
 * happened, when, to which step and by which kind of caller, never an event's captured body.
 */
export function FactoryHistory({ load }: { load: (cursor?: string) => Promise<DagHistoryPage> }) {
	const t = useT();
	const [items, setItems] = useState<DagHistoryItem[] | null>(null);
	const [next, setNext] = useState<string | undefined>();
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const read = async (cursor?: string) => {
		setBusy(true);
		setFailed(false);
		try {
			const page = await load(cursor);
			setItems((current) => [...(cursor ? (current ?? []) : []), ...page.items]);
			setNext(page.nextCursor);
		} catch {
			setFailed(true);
		}
		setBusy(false);
	};
	return (
		<details
			className="px-12"
			data-testid="factory-history"
			onToggle={(event) => {
				if (event.currentTarget.open && items === null && !busy) void read();
			}}
		>
			<summary className="cursor-pointer py-8 tr-text-metadata text-text-muted focus-visible:focus-ring-inset">
				{t("factory.history.heading")}
			</summary>
			{items?.length ? (
				<ol
					className="flex max-h-[24vh] flex-col overflow-y-auto"
					data-testid="factory-history-list"
				>
					{items.map((item) => {
						const target = historyTarget(item);
						return (
							<li
								key={item.id}
								className="flex flex-wrap items-baseline gap-x-8 py-4 tr-text-metadata"
							>
								<span className="tr-text-ui text-text-default wrap-anywhere">{item.kind}</span>
								{target ? <span className="text-text-muted wrap-anywhere">{target}</span> : null}
								{item.actor ? (
									<span className="text-text-muted">{actorLabel(t, item.actor)}</span>
								) : null}
								<time className="tabular-nums text-text-muted" dateTime={item.at}>
									{new Date(item.at).toLocaleString()}
								</time>
							</li>
						);
					})}
				</ol>
			) : items ? (
				<p className="py-4 tr-text-metadata text-text-muted">{t("factory.history.empty")}</p>
			) : null}
			{failed ? (
				<span role="alert" className="tr-text-metadata text-feedback-error">
					{t("factory.history.error")}
				</span>
			) : null}
			{next ? (
				<Button
					variant="ghost"
					size="m"
					disabled={busy}
					onClick={() => void read(next)}
					data-testid="factory-history-more"
				>
					{t("factory.history.more")}
				</Button>
			) : null}
		</details>
	);
}

/**
 * One step's named outputs: pick a name to read it from the host. The text is bounded by the host, which
 * says when it cut it; a file output shows the host's preview (text, a small image, or name and size).
 */
export function NodeOutput({
	nodeId,
	names,
	load,
}: {
	nodeId: string;
	names: readonly string[];
	load: (nodeId: string, name: string) => Promise<DagOutputView | null>;
}) {
	const t = useT();
	const [shown, setShown] = useState<string | null>(null);
	const [view, setView] = useState<DagOutputView | null | undefined>(undefined);
	const [failed, setFailed] = useState(false);
	// Only the latest read may settle the view: picking A then B must never show A's text (or error) under B.
	const latest = useRef(0);
	const toggle = async (name: string) => {
		latest.current += 1;
		const ticket = latest.current;
		if (shown === name) return setShown(null);
		setShown(name);
		setView(undefined);
		setFailed(false);
		try {
			const next = await load(nodeId, name);
			if (latest.current === ticket) setView(next);
		} catch {
			if (latest.current === ticket) setFailed(true);
		}
	};
	return (
		<span className="mt-4 flex flex-col gap-4" data-testid="factory-node-output">
			<span className="flex flex-wrap items-center gap-8">
				<span className="tr-text-metadata text-text-muted">{t("factory.output.heading")}</span>
				{names.map((name) => (
					<Button
						key={name}
						variant="ghost"
						size="m"
						aria-pressed={shown === name}
						onClick={() => void toggle(name)}
						data-testid="factory-output-toggle"
					>
						{name}
					</Button>
				))}
			</span>
			{shown && failed ? (
				<span role="alert" className="tr-text-metadata text-feedback-error">
					{t("factory.output.error")}
				</span>
			) : null}
			{shown && !failed && view === null ? (
				<span className="tr-text-metadata text-text-muted">{t("factory.output.empty")}</span>
			) : null}
			{shown && !failed && view ? (
				<>
					{view.kind === "artifact" ? (
						<ArtifactOutput view={view} />
					) : (
						<pre
							className="max-h-[24vh] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border-default bg-container-header-bg px-8 py-4 tr-code-text-small text-text-default"
							data-testid="factory-output-text"
						>
							{view.text}
						</pre>
					)}
					{view.truncated ? (
						<span className="tr-text-metadata text-text-muted">
							{t("factory.output.truncated", {
								shown: Math.round(DAG_OUTPUT_MAX_BYTES / 1024),
								size: view.sizeBytes,
							})}
						</span>
					) : null}
				</>
			) : null}
		</span>
	);
}

/**
 * An artifact output: a host older than v137 sends the size only, a newer one adds the file name, its
 * media type and, when small enough, the text (the same bounded block as a text output) or an inline
 * image. Anything else is described by name and size.
 */
function ArtifactOutput({ view }: { view: DagOutputView }) {
	const t = useT();
	const artifact = view.artifact;
	if (!artifact)
		return (
			<span className="tr-text-metadata text-text-muted" data-testid="factory-output-text">
				{t("factory.output.artifact", { size: view.sizeBytes })}
			</span>
		);
	const src = artifactImageSrc(view);
	return (
		<>
			<span className="tr-text-metadata text-text-muted" data-testid="factory-output-file">
				{t("factory.output.file", {
					name: artifact.name,
					type: artifact.mediaType,
					size: view.sizeBytes,
				})}
			</span>
			{src ? (
				<img
					src={src}
					alt={t("factory.output.imageAlt", { name: artifact.name })}
					className="max-h-[24vh] max-w-full self-start rounded-sm border border-border-default object-contain"
					data-testid="factory-output-image"
				/>
			) : view.text === undefined ? (
				<span className="tr-text-metadata text-text-muted" data-testid="factory-output-text">
					{t("factory.output.noPreview")}
				</span>
			) : (
				<pre
					className="max-h-[24vh] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border-default bg-container-header-bg px-8 py-4 tr-code-text-small text-text-default"
					data-testid="factory-output-text"
				>
					{view.text}
				</pre>
			)}
		</>
	);
}
