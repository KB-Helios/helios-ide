import { cn } from "@thinkrail/ui/utils";
import type { ContextKind, ContextToken } from "./contextPills";

const TINT: Readonly<Record<ContextKind, string>> = {
	file: "bg-primary-subtle",
	dir: "bg-primary-subtle",
	artifact: "bg-feedback-warning-subtle",
	spec: "bg-feedback-success-subtle",
	skill: "bg-primary-soft",
};

interface Segment {
	readonly start: number;
	readonly text: string;
	readonly kind: ContextKind | null;
}

function segments(value: string, tokens: readonly ContextToken[]): Segment[] {
	const out: Segment[] = [];
	let at = 0;
	for (const token of tokens) {
		if (token.start > at) out.push({ start: at, text: value.slice(at, token.start), kind: null });
		out.push({ start: token.start, text: value.slice(token.start, token.end), kind: token.kind });
		at = token.end;
	}
	if (at < value.length) out.push({ start: at, text: value.slice(at), kind: null });
	return out;
}

/**
 * Paints each context token as a tinted rounded pill behind a transparent textarea. The pill adds no
 * padding or glyph, so the text keeps the textarea's exact metrics and the caret never drifts.
 */
export function ContextPillBackdrop({
	value,
	tokens,
	backdropRef,
}: {
	value: string;
	tokens: readonly ContextToken[];
	backdropRef: (element: HTMLDivElement | null) => void;
}) {
	return (
		<div
			ref={backdropRef}
			data-testid="context-backdrop"
			aria-hidden
			className="pointer-events-none absolute inset-0 overflow-hidden rounded-sm"
		>
			<div className="w-full whitespace-pre-wrap break-words px-12 py-8 tr-text-ui">
				{segments(value, tokens).map((segment) => (
					<span
						key={segment.start}
						data-testid={segment.kind ? "context-pill" : undefined}
						data-kind={segment.kind ?? undefined}
						className={cn("text-transparent", segment.kind && cn("rounded-xs", TINT[segment.kind]))}
					>
						{segment.text}
					</span>
				))}
			</div>
		</div>
	);
}
