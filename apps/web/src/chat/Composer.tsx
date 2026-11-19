import {
	RiArrowUpLine as ArrowUp,
	RiInboxArchiveLine as ArtifactIcon,
	RiAttachmentLine as Attachment,
	RiArrowDownSLine as ChevronDown,
	RiCornerDownLeftLine as EnterKey,
	RiFileLine as FileIcon,
	RiFileList3Line as FileList,
	RiFolderLine as FolderIcon,
	RiHistoryLine as History,
	RiSparkling2Line as Sparkles,
	RiStopFill as StopFill,
	RiGitBranchLine as Worktree,
} from "@remixicon/react";
import type { ComposerGrowthLimit, ThinkingLevel, WireModel } from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { useT } from "@thinkrail/locales/react";
import { Button, IconButton } from "@thinkrail/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@thinkrail/ui/dropdown-menu";
import { hasPlatformModifier, isImeComposing, keyCap } from "@thinkrail/ui/keyboard";
import { useLocalKeys } from "@thinkrail/ui/local-keys";
import { Popover, PopoverContent, PopoverTrigger } from "@thinkrail/ui/popover";
import { IconTooltip } from "@thinkrail/ui/tooltip";
import { cn } from "@thinkrail/ui/utils";
import {
	Fragment,
	forwardRef,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { LOCAL_KEY_DEFAULTS } from "@/keybindings";
import {
	activeContextTrigger,
	applyTemplateSlotEdit,
	beginTemplateSlotSession,
	type ContextCandidate,
	type ContextKnowledge,
	ContextPillBackdrop,
	type ContextTriggerChar,
	contextCandidateKey,
	contextTokenCount,
	finalizeTemplateSlotSession,
	findContextTokens,
	highlightSegments,
	insertContextCandidate,
	type ParsedTemplate,
	type SlashCommandItem,
	SlashCommandMenu,
	type SlotHighlightState,
	type SlotSegment,
	selectedSlashCommandValue,
	slashCommandQuery,
	stepTemplateSlotSession,
	TemplateSlotHint,
	type TemplateSlotSessionState,
	usePendingSelection,
	useSlashCommandCompletion,
} from "@/prompt";
import { DICTATION_EVENT } from "@/speech";
import { FileChip } from "./FileChip";
import {
	ModelEffortPicker,
	type ModelEffortPickerHandle,
	type ModelSelection,
} from "./ModelEffortPicker";
import { isModelCommand, parseModelCommand } from "./nativeCommands";
import {
	imagePasteDropHandlers,
	PromptImageChips,
	type PromptImagesOwner,
	usePromptImages,
} from "./promptImages";
import { composerShiftTabOut, composerTranscriptStep } from "./transcriptNavigation";
import type { ChatAttachment } from "./types";
import type { ModelPreferences } from "./useModelPreferences";

export type SubmitBehavior = "send" | "steer" | "followUp" | "interrupt";

/** Where the next prompt runs: this chat in the current worktree, or a new isolated worktree. */
export type ExecutionMode = "workspace" | "worktree";

const EXECUTION_MODE_ORDER: readonly ExecutionMode[] = ["workspace", "worktree"];

const EXECUTION_MODE_COPY: Readonly<
	Record<ExecutionMode, { name: MessageKey; meaning: MessageKey; icon: typeof FolderIcon }>
> = {
	workspace: {
		name: "chat.composer.execution.workspace",
		meaning: "chat.composer.execution.workspaceMeaning",
		icon: FolderIcon,
	},
	worktree: {
		name: "chat.composer.execution.worktree",
		meaning: "chat.composer.execution.worktreeMeaning",
		icon: Worktree,
	},
};

function ModeIcon({ mode }: { mode: ExecutionMode }) {
	const Icon = EXECUTION_MODE_COPY[mode].icon;
	return <Icon />;
}

export type ComposerSubmitDisposition = { accepted: true } | { accepted: false; reason: string };

const COMPOSER_EDITOR_LIMIT_CLASS = {
	compact: "max-h-[calc(6lh+var(--space-8)+var(--space-8))]",
	roomy: "max-h-[calc(10lh+var(--space-8)+var(--space-8))]",
	"half-chat":
		"max-h-[calc(50cqh-var(--space-16)-var(--space-16)-var(--space-4)-var(--space-4)-var(--space-4)-var(--space-4))]",
} satisfies Record<ComposerGrowthLimit, string>;

const WIDE_ONLY = "@max-md:hidden";
const COMPACT_ONLY = "@md:hidden";

const SEGMENT =
	"flex items-center gap-4 transition-colors focus-visible:focus-ring disabled:pointer-events-none";

const SEND_PILL = "flex h-28 shrink-0 items-stretch rounded-full transition-colors";
const SEND_PILL_ARMED = "bg-control-primary-bg text-control-primary-text";
const SEND_PILL_INERT = "bg-control-bg-selected text-control-disabled-text";
const SEND_MAIN = cn(
	SEGMENT,
	"rounded-full pl-12 @max-md:w-28 @max-md:justify-center @max-md:px-0",
);
const SEND_MORE = cn(SEGMENT, "rounded-r-full pr-8 pl-2");
const KEYCAP = "flex h-16 min-w-16 items-center justify-center rounded-xs bg-on-primary-soft px-2";

/**
 * Completion menus sit over the composer's left edge. The composer is a centred column of the
 * transcript width, so in a wide pane the menu follows the column instead of the pane's edge; the
 * offset is clamped so the menu (at most min(28rem, 90%) wide) never overruns the composer's right edge.
 */
const MENU_LEFT =
	"left-[clamp(var(--space-12),calc((100%-var(--chat-transcript-width))/2+var(--chat-gutter)),max(var(--space-12),calc(100%-min(28rem,90%)-var(--space-12))))]";

const COMPOSER_CONTROLS =
	"a,button,input,label,select,textarea,[role='button'],[role='menuitem'],[role='option']";

function isComposerDeadZone(
	{ button, target }: MouseEvent<HTMLElement>,
	shell: HTMLElement | null,
) {
	return (
		button === 0 &&
		target instanceof Element &&
		shell?.contains(target) === true &&
		!target.closest(COMPOSER_CONTROLS)
	);
}

const STREAMING_SEND_MODES = [
	{
		behavior: "steer" as const,
		name: "chat.composer.mode.steer",
		meaning: "chat.composer.mode.steerMeaning",
		command: null,
		testid: "send-mode-steer",
	},
	{
		behavior: "followUp" as const,
		name: "chat.composer.mode.queue",
		meaning: "chat.composer.mode.queueMeaning",
		command: "composer.followUp",
		testid: "send-mode-queue",
	},
	{
		behavior: "interrupt" as const,
		name: "chat.composer.mode.interrupt",
		meaning: "chat.composer.mode.interruptMeaning",
		command: "composer.interrupt",
		testid: "send-mode-interrupt",
	},
] satisfies {
	behavior: SubmitBehavior;
	name: MessageKey;
	meaning: MessageKey;
	command: string | null;
	testid: string;
}[];

const CONTEXT_SECTION_LABELS = {
	file: "chat.composer.context.files",
	dir: "chat.composer.context.files",
	artifact: "chat.composer.context.artifacts",
	spec: "chat.composer.context.specs",
	skill: "chat.composer.context.skills",
} as const satisfies Record<ContextCandidate["kind"], MessageKey>;

function contextCandidateIcon(candidate: ContextCandidate) {
	switch (candidate.kind) {
		case "dir":
			return FolderIcon;
		case "artifact":
			return ArtifactIcon;
		case "spec":
			return FileList;
		case "skill":
			return Sparkles;
		default:
			return FileIcon;
	}
}

function withOffsets(segments: SlotSegment[]): (SlotSegment & { start: number })[] {
	let offset = 0;
	return segments.map((seg) => {
		const start = offset;
		offset += seg.text.length;
		return { ...seg, start };
	});
}

function highlightTint(state: SlotHighlightState): string {
	switch (state) {
		case "unfilled":
			return "rounded-xs bg-primary-soft";
		case "active":
			return "rounded-xs bg-primary-muted";
		case "filled":
			return "rounded-xs bg-primary-subtle";
		case "plain":
			return "";
	}
}

interface ComposerProps {
	value: string;
	onChange: (value: string) => void;
	imageOwner?: PromptImagesOwner;
	isStreaming: boolean;
	awaitingResponse: boolean;
	growthLimit: ComposerGrowthLimit;
	commands: SlashCommandItem[];
	templatePending: boolean;
	contextCandidates: ContextCandidate[];
	contextKnowledge: ContextKnowledge;
	/** `null` hides the selector: a chat without a repository, or a run in flight, cannot isolate. */
	executionMode: ExecutionMode | null;
	onExecutionModeChange: (mode: ExecutionMode) => void;
	recentPrompts: string[];
	models: WireModel[];
	modelsRefreshing: boolean;
	onRefreshModels: (force: boolean) => void;
	currentModel: WireModel | null;
	thinkingLevel: ThinkingLevel;
	modelPreferences: ModelPreferences;
	onContextQuery: (trigger: ContextTriggerChar | null, query: string) => void;
	onSlashActive: (active: boolean) => void;
	onSelectModel: (selection: ModelSelection) => void;
	onSelectThinking: (level: ThinkingLevel) => void;
	onSubmit: (
		text: string,
		attachments: ChatAttachment[],
		behavior: SubmitBehavior,
	) => ComposerSubmitDisposition;
	onAbort: () => void;
	onEnterTranscript?: () => void;
	onShiftTabOut?: () => boolean;
	onScrollTranscript?: (direction: -1 | 1) => void;
	onHistoryOpen?: () => void;
	onPickTemplate?: (name: string) => void;
	onManageTemplates?: () => void;
	templatesEmpty?: boolean;
}

export interface ComposerHandle {
	insertText: (text: string) => void;
	applyEdit: (kind: "replace" | "paste", text: string) => void;
	insertAndSubmit: (text: string, behavior: SubmitBehavior) => void;
	insertTemplate: (parsed: ParsedTemplate) => void;
	restoreAttachments: (attachments: ChatAttachment[]) => void;
	openHistory: () => void;
	refocus: () => void;
	ownsEscape: () => boolean;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
	{
		value,
		onChange,
		imageOwner,
		isStreaming,
		awaitingResponse,
		growthLimit,
		commands,
		templatePending,
		contextCandidates,
		contextKnowledge,
		executionMode,
		onExecutionModeChange,
		recentPrompts,
		models,
		modelsRefreshing,
		onRefreshModels,
		currentModel,
		thinkingLevel,
		modelPreferences,
		onContextQuery,
		onSlashActive,
		onSelectModel,
		onSelectThinking,
		onSubmit,
		onAbort,
		onEnterTranscript,
		onShiftTabOut,
		onScrollTranscript,
		onHistoryOpen,
		onPickTemplate,
		onManageTemplates,
		templatesEmpty,
	},
	handleRef,
) {
	const t = useT();
	const keys = useLocalKeys("composer", LOCAL_KEY_DEFAULTS.composer);
	const ref = useRef<HTMLTextAreaElement>(null);
	const pickerRef = useRef<ModelEffortPickerHandle>(null);
	const [caret, setCaret] = useState(0);
	const attachedImages = usePromptImages(imageOwner);
	const { images } = attachedImages;
	const [submitError, setSubmitError] = useState<string | null>(null);
	const pendingImages = attachedImages.pending;
	useEffect(() => {
		if (images.length === 0) setSubmitError(null);
	}, [images.length]);
	const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
	const [mentionDismissed, setMentionDismissed] = useState(false);
	const [sendMenuOpen, setSendMenuOpen] = useState(false);
	const recallIdxRef = useRef<number | null>(null);
	const [slotSession, setSlotSession] = useState<TemplateSlotSessionState | null>(null);
	const slots = slotSession?.slots ?? null;
	const slotIdx = slotSession?.activeIndex ?? 0;
	const backdropRef = useRef<HTMLDivElement | null>(null);
	const editorSizerRef = useRef<HTMLDivElement | null>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const [draftNeedsExpansion, setDraftNeedsExpansion] = useState(false);
	const expanded = isStreaming || draftNeedsExpansion;
	const syncBackdropScroll = useCallback(() => {
		const backdrop = backdropRef.current;
		const textarea = ref.current;
		if (!backdrop || !textarea) return;
		backdrop.scrollLeft = textarea.scrollLeft;
		backdrop.scrollTop = textarea.scrollTop;
	}, []);
	const attachBackdrop = useCallback(
		(el: HTMLDivElement | null) => {
			backdropRef.current = el;
			syncBackdropScroll();
		},
		[syncBackdropScroll],
	);
	const measureDraftExpansion = useCallback(() => {
		const sizer = editorSizerRef.current;
		if (!sizer) return;
		const styles = getComputedStyle(sizer);
		const oneLineHeight =
			Number.parseFloat(styles.lineHeight) +
			Number.parseFloat(styles.paddingTop) +
			Number.parseFloat(styles.paddingBottom);
		setDraftNeedsExpansion(value.includes("\n") || sizer.scrollHeight > oneLineHeight + 1);
	}, [value]);

	useLayoutEffect(() => {
		const sizer = editorSizerRef.current;
		if (!sizer) return;
		measureDraftExpansion();
		const observer = new ResizeObserver(measureDraftExpansion);
		observer.observe(sizer);
		return () => observer.disconnect();
	}, [measureDraftExpansion]);

	useLayoutEffect(() => {
		syncBackdropScroll();
	});

	const trigger = activeContextTrigger(value, caret);
	const triggerChar = trigger?.trigger ?? null;
	const triggerQuery = trigger?.query ?? "";
	const slashQuery = slashCommandQuery(value);
	const pillTokens = findContextTokens(value, contextKnowledge);
	const contextCount = contextTokenCount(value, contextKnowledge) + images.length;

	useEffect(
		() => onContextQuery(triggerChar, triggerQuery),
		[triggerChar, triggerQuery, onContextQuery],
	);
	useEffect(() => onSlashActive(slashQuery !== null), [slashQuery, onSlashActive]);
	useEffect(() => {
		setMentionActiveIndex(0);
		setMentionDismissed(false);
	}, [triggerChar, triggerQuery]);

	const mentionOpen = !mentionDismissed && trigger !== null && contextCandidates.length > 0;

	const focusSelection = usePendingSelection(ref, setCaret);

	const replaceDraft = useCallback(
		(text: string, caret?: number, focus = true) => {
			const selection = caret ?? text.length;
			recallIdxRef.current = null;
			setSlotSession(null);
			setSubmitError(null);
			onChange(text);
			if (focus) focusSelection(selection);
			else setCaret(selection);
		},
		[onChange, focusSelection],
	);

	const [dictating, setDictating] = useState(false);
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const onDictation = (event: Event) => {
			if (event instanceof CustomEvent)
				setDictating(Reflect.get(Object(event.detail), "listening") === true);
		};
		element.addEventListener(DICTATION_EVENT, onDictation);
		return () => element.removeEventListener(DICTATION_EVENT, onDictation);
	}, []);

	const canSubmit = (raw: string) =>
		!dictating && !templatePending && pendingImages === 0 && (!!raw.trim() || images.length > 0);
	const canSend = canSubmit(value);

	const openModelPicker = (query: string) => {
		replaceDraft("");
		pickerRef.current?.open(query);
	};

	const submitText = (raw: string, behavior: SubmitBehavior) => {
		if (!canSubmit(raw)) return;
		const text = raw.trim();
		const modelQuery = parseModelCommand(text);
		if (modelQuery !== null) {
			openModelPicker(modelQuery);
			return;
		}
		const disposition = onSubmit(
			text,
			images.map(({ name, content }) => ({ name, content })),
			behavior,
		);
		if (!disposition.accepted) {
			setSubmitError(disposition.reason);
			return;
		}
		setSubmitError(null);
		onChange("");
		attachedImages.reset();
		recallIdxRef.current = null;
		setSlotSession(null);
	};

	const pickContext = (candidate: ContextCandidate) => {
		if (!trigger) return;
		const next = insertContextCandidate(value, caret, trigger, candidate, contextKnowledge);
		replaceDraft(next.value, next.caret);
	};

	const slashCompletion = useSlashCommandCompletion({
		value,
		commands,
		onSelect: (command) => {
			if (isModelCommand(command)) openModelPicker("");
			else if (command.source === "prompt" && onPickTemplate) onPickTemplate(command.name);
			else replaceDraft(selectedSlashCommandValue(command));
		},
	});

	const menuOpen = mentionOpen || slashCompletion.open;

	const openHistory = () => {
		setMentionDismissed(true);
		slashCompletion.dismiss();
		onHistoryOpen?.();
	};

	useImperativeHandle(handleRef, () => ({
		insertText: (text: string) => replaceDraft(text),
		applyEdit: (kind: "replace" | "paste", text: string) => {
			const textarea = ref.current;
			const focused = textarea !== null && textarea === document.activeElement;
			if (kind === "replace") {
				replaceDraft(text, text.length, focused);
				return;
			}
			const start = focused ? textarea.selectionStart : value.length;
			const end = focused ? textarea.selectionEnd : value.length;
			replaceDraft(
				`${value.slice(0, start)}${text}${value.slice(end)}`,
				start + text.length,
				focused,
			);
		},
		insertAndSubmit: (text: string, behavior: SubmitBehavior) =>
			canSubmit(text) ? submitText(text, behavior) : replaceDraft(text),
		insertTemplate: (parsed: ParsedTemplate) => {
			const transition = beginTemplateSlotSession(parsed);
			recallIdxRef.current = null;
			setSubmitError(null);
			onChange(transition.value);
			setSlotSession(transition.session);
			focusSelection(transition.selection.start, transition.selection.end);
		},
		restoreAttachments: (attachments: ChatAttachment[]) => {
			if (attachments.length === 0) return;
			attachedImages.restore(attachments);
			setSubmitError(null);
			focusSelection(caret);
		},
		openHistory,
		refocus: () => {
			const slot = slots?.[slotIdx];
			if (slot) focusSelection(slot.start, slot.end);
			else focusSelection(caret);
		},
		ownsEscape: () =>
			ref.current !== null &&
			ref.current === document.activeElement &&
			(menuOpen || slots !== null),
	}));

	const submit = (behavior: SubmitBehavior) => {
		submitText(finalizeTemplateSlotSession(value, slotSession), behavior);
	};

	const stepSlot = (direction: 1 | -1) => {
		if (!slotSession) return;
		const transition = stepTemplateSlotSession(value, slotSession, direction);
		if (transition.value !== value) onChange(transition.value);
		setSlotSession(transition.session);
		focusSelection(transition.selection.start, transition.selection.end);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (isImeComposing(e.nativeEvent)) return;
		const local = keys.match(e.nativeEvent);
		if (onEnterTranscript && local === "composer.enterTranscript") {
			e.preventDefault();
			const { selectionStart, selectionEnd } = e.currentTarget;
			const atStart = selectionStart === 0 && selectionEnd === 0;
			if (composerTranscriptStep(draftNeedsExpansion, atStart) === "enter") onEnterTranscript();
			else focusSelection(0);
			return;
		}
		if (local === "composer.interrupt" || local === "composer.followUp") {
			e.preventDefault();
			submit(isStreaming ? (local === "composer.interrupt" ? "interrupt" : "followUp") : "send");
			return;
		}
		const fixed = local === null && !e.altKey && !e.ctrlKey && !e.metaKey;
		if (fixed && slots && !menuOpen) {
			if (e.key === "Tab") {
				e.preventDefault();
				stepSlot(e.shiftKey ? -1 : 1);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setSlotSession(null);
				return;
			}
		}
		if (fixed && mentionOpen) {
			const menuLen = contextCandidates.length;
			if (e.key === "ArrowDown" && !e.shiftKey) {
				e.preventDefault();
				setMentionActiveIndex((i) => (i + 1) % menuLen);
				return;
			}
			if (e.key === "ArrowUp" && !e.shiftKey) {
				e.preventDefault();
				setMentionActiveIndex((i) => (i - 1 + menuLen) % menuLen);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				setMentionDismissed(true);
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const candidate = contextCandidates[mentionActiveIndex];
				if (candidate) pickContext(candidate);
				return;
			}
		}
		if (fixed && slashCompletion.handleKeyDown(e)) return;
		if (composerShiftTabOut(e, menuOpen || slots !== null) && onShiftTabOut?.()) {
			e.preventDefault();
			return;
		}
		if (
			onScrollTranscript &&
			fixed &&
			(e.key === "PageUp" || e.key === "PageDown") &&
			!e.shiftKey
		) {
			e.preventDefault();
			onScrollTranscript(e.key === "PageUp" ? -1 : 1);
			return;
		}
		if (local !== null) return;
		const recallAt = recallIdxRef.current;
		const recallKey = fixed && !e.shiftKey;
		if (
			recallKey &&
			e.key === "ArrowUp" &&
			(value === "" || recallAt !== null) &&
			recentPrompts.length > 0
		) {
			e.preventDefault();
			setSlotSession(null);
			const next = recallAt === null ? 0 : Math.min(recallAt + 1, recentPrompts.length - 1);
			const text = recentPrompts[next] ?? "";
			recallIdxRef.current = next;
			onChange(text);
			focusSelection(text.length);
			return;
		}
		if (recallKey && e.key === "ArrowDown" && recallAt !== null) {
			e.preventDefault();
			setSlotSession(null);
			if (recallAt === 0) {
				recallIdxRef.current = null;
				onChange("");
				focusSelection(0);
			} else {
				const next = recallAt - 1;
				const text = recentPrompts[next] ?? "";
				recallIdxRef.current = next;
				onChange(text);
				focusSelection(text.length);
			}
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !hasPlatformModifier(e.nativeEvent)) {
			e.preventDefault();
			submit(isStreaming ? "steer" : "send");
		}
	};

	const { onPaste, onDrop } = imagePasteDropHandlers(attachedImages);

	return (
		<fieldset
			data-testid="chat-composer"
			data-expanded={expanded}
			data-streaming={isStreaming}
			aria-label={t("chat.composer.label")}
			onMouseDown={(e) => {
				if (isComposerDeadZone(e, shellRef.current)) {
					e.preventDefault();
					ref.current?.focus();
				}
			}}
			className="relative m-0 flex min-w-0 shrink-0 flex-col border-0 bg-container-workspace-bg p-0"
		>
			{mentionOpen ? (
				<div
					data-testid="mention-menu"
					className={cn(
						"absolute bottom-full mb-4 max-h-[40vh] w-[min(28rem,90%)] overflow-y-auto rounded-md border border-border-default bg-container-elevated-bg p-4 shadow-[var(--shadow-md)]",
						MENU_LEFT,
					)}
				>
					{contextCandidates.map((candidate, index) => {
						const Icon = contextCandidateIcon(candidate);
						const section = CONTEXT_SECTION_LABELS[candidate.kind];
						const previous = contextCandidates[index - 1];
						const startsSection =
							previous === undefined || CONTEXT_SECTION_LABELS[previous.kind] !== section;
						return (
							<Fragment key={contextCandidateKey(candidate)}>
								{startsSection ? (
									<div
										data-testid="mention-section"
										className="px-8 pt-4 pb-2 text-text-subtle tr-text-metadata"
									>
										{t(section)}
									</div>
								) : null}
								<button
									type="button"
									data-testid="mention-item"
									data-kind={candidate.kind}
									onClick={() => pickContext(candidate)}
									className={`flex w-full items-center gap-8 rounded-sm px-8 py-4 text-left tr-text-ui focus-visible:focus-ring-inset ${index === mentionActiveIndex ? "bg-control-bg-selected text-text-default" : "text-text-muted"}`}
								>
									<Icon className="size-14 shrink-0" />
									<span className="truncate">
										{candidate.kind === "spec"
											? `#${candidate.id}`
											: candidate.kind === "skill"
												? `/${candidate.command}`
												: candidate.path}
									</span>
									{candidate.kind === "spec" ? (
										<span className="min-w-0 truncate text-text-subtle tr-text-metadata">
											{candidate.title}
										</span>
									) : candidate.kind === "skill" && candidate.description ? (
										<span className="min-w-0 truncate text-text-subtle tr-text-metadata">
											{candidate.description}
										</span>
									) : null}
								</button>
							</Fragment>
						);
					})}
				</div>
			) : slashCompletion.open ? (
				<SlashCommandMenu
					commands={slashCompletion.matches}
					activeIndex={slashCompletion.activeIndex}
					onSelect={slashCompletion.pick}
					className={cn("absolute bottom-full mb-4", MENU_LEFT)}
					footer={
						templatesEmpty && onManageTemplates ? (
							<button
								type="button"
								data-testid="slash-templates-empty"
								onClick={() => {
									replaceDraft("");
									onManageTemplates();
								}}
								className="flex w-full items-center gap-8 rounded-sm border-border-default border-t px-8 py-4 text-left text-text-muted tr-text-metadata hover:bg-control-bg-hovered hover:text-text-default focus-visible:focus-ring"
							>
								<Sparkles className="size-12 shrink-0" />
								<span className="truncate">{t("chat.composer.noTemplates")}</span>
							</button>
						) : null
					}
				/>
			) : null}

			{slots && !menuOpen ? (
				<TemplateSlotHint
					activeIndex={slotIdx}
					count={slots.length}
					onNext={() => stepSlot(1)}
					className={cn("absolute bottom-full mb-4", MENU_LEFT)}
				/>
			) : null}

			<PromptImageChips
				controller={attachedImages}
				leading={
					submitError ? (
						<FileChip
							data-testid="composer-command-error"
							tone="error"
							icon={false}
							title={submitError}
							label={submitError}
						/>
					) : null
				}
			/>

			<div className="mx-auto box-border w-full max-w-[var(--chat-transcript-width)] px-chat-gutter pt-4 pb-12">
				<div
					ref={shellRef}
					data-testid="chat-composer-shell"
					className={cn(
						"relative grid grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] items-end gap-x-4 gap-y-4 overflow-hidden rounded-2xl border border-control-border-default bg-control-bg bg-clip-padding p-6 shadow-[var(--shadow-md)] transition-colors focus-within:border-control-border-active has-[textarea:focus-visible]:focus-ring",
						expanded && growthLimit === "half-chat" && "max-h-[50cqh]",
					)}
				>
					<div className="col-start-1 row-start-2 flex min-w-0 items-center self-end">
						<ModelEffortPicker
							ref={pickerRef}
							models={models}
							current={currentModel}
							level={thinkingLevel}
							refreshing={modelsRefreshing}
							onRefresh={onRefreshModels}
							onSelect={onSelectModel}
							onSelectLevel={onSelectThinking}
							preferences={modelPreferences}
							className="max-w-[60vw] px-4 sm:max-w-[320px]"
						/>
						{executionMode ? (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="s"
										iconLeft={executionMode === "worktree" ? Worktree : FolderIcon}
										iconRight={ChevronDown}
										data-testid="execution-mode"
										data-mode={executionMode}
										aria-label={t("chat.composer.execution.label")}
										tooltip={t("chat.composer.execution.label")}
										className="ml-4 shrink-0"
									>
										<span className={WIDE_ONLY}>{t(EXECUTION_MODE_COPY[executionMode].name)}</span>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent side="top" align="start" className="w-[300px]">
									<DropdownMenuRadioGroup
										value={executionMode}
										onValueChange={(next) => {
											const chosen = EXECUTION_MODE_ORDER.find((mode) => mode === next);
											if (chosen) onExecutionModeChange(chosen);
										}}
									>
										{EXECUTION_MODE_ORDER.map((mode) => (
											<DropdownMenuRadioItem
												key={mode}
												value={mode}
												data-testid={`execution-mode-${mode}`}
												className="flex-col items-start gap-2"
											>
												<span className="flex items-center gap-4 text-text-default">
													<ModeIcon mode={mode} />
													{t(EXECUTION_MODE_COPY[mode].name)}
												</span>
												<span className="text-text-muted tr-text-metadata">
													{t(EXECUTION_MODE_COPY[mode].meaning)}
												</span>
											</DropdownMenuRadioItem>
										))}
									</DropdownMenuRadioGroup>
								</DropdownMenuContent>
							</DropdownMenu>
						) : null}
						{contextCount > 0 ? (
							<IconTooltip label={t("chat.composer.contextCount", { count: contextCount })}>
								<span
									data-testid="composer-context-count"
									role="img"
									aria-label={t("chat.composer.contextCount", { count: contextCount })}
									className="ml-4 inline-flex shrink-0 items-center gap-2 text-text-muted tr-text-metadata tabular-nums"
								>
									<Attachment className="size-12" />
									{contextCount}
								</span>
							</IconTooltip>
						) : null}
					</div>
					<div
						className={cn(
							"relative col-span-3 col-start-1 row-start-1 min-h-0 overflow-hidden rounded-sm tr-text-ui",
							COMPOSER_EDITOR_LIMIT_CLASS[growthLimit],
						)}
					>
						<div
							ref={editorSizerRef}
							data-testid="chat-input-sizer"
							aria-hidden
							className="invisible w-full whitespace-pre-wrap break-words px-12 py-8 tr-text-ui"
						>
							{`${value}\u200b`}
						</div>
						{slots ? (
							<div
								ref={attachBackdrop}
								data-testid="slot-backdrop"
								aria-hidden
								className="pointer-events-none absolute inset-0 overflow-hidden rounded-sm"
							>
								<div className="w-full whitespace-pre-wrap break-words px-12 py-8 tr-text-ui">
									{withOffsets(highlightSegments(value, slots, slotIdx)).map((seg) => (
										<span
											key={seg.start}
											data-testid={seg.state === "plain" ? undefined : "slot-highlight"}
											data-slot-state={seg.state === "plain" ? undefined : seg.state}
											className={`text-transparent ${highlightTint(seg.state)}`}
										>
											{seg.text}
										</span>
									))}
								</div>
							</div>
						) : !slots && pillTokens.length > 0 ? (
							<ContextPillBackdrop value={value} tokens={pillTokens} backdropRef={attachBackdrop} />
						) : null}
						<textarea
							ref={ref}
							data-testid="chat-input"
							data-dictation-fallback
							data-focus-default
							value={value}
							onScroll={syncBackdropScroll}
							onChange={(e) => {
								const next = e.target.value;
								const nextCaret = e.target.selectionStart;
								setSubmitError(null);
								const recalled = recallIdxRef.current;
								if (recalled !== null && next !== recentPrompts[recalled]) {
									recallIdxRef.current = null;
								}
								if (slotSession) {
									setSlotSession(applyTemplateSlotEdit(value, next, nextCaret, slotSession));
								}
								onChange(next);
								setCaret(nextCaret);
							}}
							onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
							onClick={(e) => setCaret(e.currentTarget.selectionStart)}
							onKeyDown={onKeyDown}
							onPaste={onPaste}
							onDrop={onDrop}
							rows={1}
							placeholder={
								awaitingResponse
									? t("chat.composer.placeholderQuestion")
									: isStreaming
										? t("chat.composer.placeholderStreaming")
										: expanded
											? t("chat.composer.placeholderExpanded")
											: t("chat.composer.placeholder")
							}
							className={cn(
								"absolute inset-0 size-full resize-none overflow-x-hidden overflow-y-auto rounded-sm bg-transparent px-12 py-8 tr-text-ui text-text-default outline-none placeholder:text-text-muted",
								expanded ? "whitespace-pre-wrap" : "whitespace-nowrap",
							)}
						/>
					</div>
					<div className="col-start-3 row-start-2 flex shrink-0 items-center gap-4 self-end">
						<IconButton
							icon={History}
							data-testid="history-open"
							data-history-trigger
							label={t("chat.composer.searchHistory")}
							onClick={openHistory}
						/>
						{isStreaming ? (
							<Button
								variant="ghost"
								size="m"
								iconLeft={StopFill}
								data-testid="chat-abort"
								data-neon="stream"
								aria-label={t("chat.composer.stop")}
								tooltip={t("chat.composer.stop")}
								onClick={onAbort}
								className="shrink-0 @max-md:w-24 @max-md:px-0"
							>
								<span className={WIDE_ONLY}>{t("chat.composer.stop")}</span>
							</Button>
						) : null}
						<div
							data-testid="chat-send-pill"
							data-neon="cta"
							data-armed={canSend}
							className={cn(SEND_PILL, canSend ? SEND_PILL_ARMED : SEND_PILL_INERT)}
						>
							<button
								type="button"
								data-testid="chat-send"
								aria-label={isStreaming ? t("chat.composer.steer") : t("chat.composer.send")}
								onClick={() => submit(isStreaming ? "steer" : "send")}
								disabled={!canSend}
								className={cn(
									SEND_MAIN,
									"tr-text-action hover:bg-control-primary-bg-hovered",
									isStreaming ? "rounded-r-none pr-4" : "pr-12",
								)}
							>
								<ArrowUp className={cn("size-16", COMPACT_ONLY)} />
								<span className={WIDE_ONLY}>
									{isStreaming ? t("chat.composer.steer") : t("chat.composer.send")}
								</span>
								<kbd aria-hidden className={cn(KEYCAP, WIDE_ONLY)}>
									<EnterKey className="size-12" />
								</kbd>
							</button>
							{isStreaming ? (
								<Popover open={sendMenuOpen} onOpenChange={setSendMenuOpen}>
									<IconTooltip label={t("chat.composer.sendOptions")} wrapTrigger>
										<PopoverTrigger asChild>
											<button
												type="button"
												data-testid="send-menu"
												aria-label={t("chat.composer.sendOptions")}
												className={cn(
													SEND_MORE,
													canSend
														? "hover:bg-control-primary-bg-hovered"
														: "hover:text-text-default",
												)}
											>
												<ChevronDown className="size-14" />
											</button>
										</PopoverTrigger>
									</IconTooltip>
									<PopoverContent side="top" align="end" className="w-[320px] p-4">
										<div className="flex flex-col gap-2">
											{STREAMING_SEND_MODES.map((mode) => (
												<button
													key={mode.behavior}
													type="button"
													data-testid={mode.testid}
													disabled={!canSend}
													onClick={() => {
														setSendMenuOpen(false);
														submit(mode.behavior);
													}}
													className="group flex w-full flex-col gap-2 rounded-sm px-8 py-4 text-left hover:bg-control-bg-hovered focus-visible:focus-ring-inset disabled:pointer-events-none"
												>
													<span className="flex w-full items-baseline justify-between gap-8">
														<span className="text-text-default tr-text-ui group-disabled:text-control-disabled-text">
															{t(mode.name)}
														</span>
														<span className="shrink-0 text-text-muted tr-text-metadata group-disabled:text-control-disabled-text">
															{mode.command === null ? keyCap("Enter") : keys.label(mode.command)}
														</span>
													</span>
													<span className="text-text-muted tr-text-metadata group-disabled:text-control-disabled-text">
														{t(mode.meaning)}
													</span>
												</button>
											))}
										</div>
									</PopoverContent>
								</Popover>
							) : null}
						</div>
					</div>
				</div>
			</div>
		</fieldset>
	);
});
