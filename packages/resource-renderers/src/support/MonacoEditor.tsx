import { useT } from "@thinkrail/locales/react";
import { onFontsChange } from "@thinkrail/ui/fonts";
import type { editor } from "monaco-editor/editor/editor.api.js";
import {
	useEffect,
	useEffectEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { type ResourceHost, useResourceHost, useResourcePreferences } from "../host";
import type { ResourceViewProps, SurfaceReview } from "../registry";
import { MonacoReviewZones } from "./MonacoReviewZones";
import { decorateEditorContextMenus } from "./monacoMenuIcons";
import {
	createFileEditor,
	disposeFileEditor,
	editorFont,
	ensureMonaco,
	fileEditorOptions,
	remeasureEditorFonts,
	revealLineNow,
	syncFileModel,
} from "./monacoSetup";
import { focusCommentCardWhenRendered } from "./revealFocus";
import {
	applyReviewDecorations,
	attachReviewCommenting,
	attachReviewThreads,
	type MonacoReviewZoneState,
	type ReviewCommenting,
} from "./reviewWidgets";

function focusLine(review: SurfaceReview): number | null {
	const range = review.focus?.anchor.selectors.find((selector) => selector.kind === "lineRange");
	return range?.kind === "lineRange" ? range.startLine : null;
}

function isEditorViewState(value: unknown): value is editor.ICodeEditorViewState {
	if (typeof value !== "object" || value === null) return false;
	return Array.isArray(Reflect.get(value, "cursorState")) && Reflect.has(value, "viewState");
}

const FLASH_MS = 1500;

type FlashState = { collection: editor.IEditorDecorationsCollection; timer: number } | null;

function clearFlash(flashRef: { current: FlashState }): void {
	const flash = flashRef.current;
	if (!flash) return;
	window.clearTimeout(flash.timer);
	flash.collection.clear();
	flashRef.current = null;
}

/** Marks `line` with the accent for `FLASH_MS`; a newer flash replaces an older one. */
function flashLine(
	codeEditor: editor.IStandaloneCodeEditor,
	flashRef: { current: FlashState },
	line: number,
): void {
	clearFlash(flashRef);
	const collection = codeEditor.createDecorationsCollection([
		{
			range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
			options: { isWholeLine: true, className: "follow-flash-line" },
		},
	]);
	flashRef.current = { collection, timer: window.setTimeout(() => clearFlash(flashRef), FLASH_MS) };
}

export function warm(host: ResourceHost): void {
	ensureMonaco(host.code);
}

export default function MonacoEditor({
	resource,
	content,
	review,
	viewState,
	onViewState,
	reveal,
	onRevealHandled,
	onUserNavigated,
}: ResourceViewProps) {
	const t = useT();
	const { fileLineWidth, fileLineWidthBounded } = useResourcePreferences();
	ensureMonaco(useResourceHost().code);
	const scope = useId().replace(/[^\w-]/g, "");
	const path = resource.path;
	const text = content.kind === "text" ? content.text : "";
	const commentLabels = {
		selection: t("review.widget.commentOnSelection"),
		line: t("viewer.code.commentOnLine"),
	};
	const font = useSyncExternalStore(onFontsChange, editorFont);
	const options = fileEditorOptions(t, fileLineWidth, fileLineWidthBounded, resource.path, font);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const commentingRef = useRef<ReviewCommenting | null>(null);
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const threadsRef = useRef<ReturnType<typeof attachReviewThreads> | null>(null);
	const decorationsRef = useRef<string[]>([]);
	const freshMountRef = useRef(false);
	const flashRef = useRef<{
		collection: editor.IEditorDecorationsCollection;
		timer: number;
	} | null>(null);
	const appliedRef = useRef({ scope, path, text, options });
	const latestRef = useRef({
		scope,
		path,
		text,
		options,
		commentLabels,
		viewState,
		review,
		onViewState,
		onUserNavigated,
	});
	const [reviewZones, setReviewZones] = useState<MonacoReviewZoneState>({
		threads: [],
		composer: null,
	});

	useLayoutEffect(() => {
		latestRef.current = {
			scope,
			path,
			text,
			options,
			commentLabels,
			viewState,
			review,
			onViewState,
			onUserNavigated,
		};
	});

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const mount = latestRef.current;
		const codeEditor = createFileEditor(container, mount);
		editorRef.current = codeEditor;
		freshMountRef.current = true;
		appliedRef.current = {
			scope: mount.scope,
			path: mount.path,
			text: mount.text,
			options: mount.options,
		};
		const menuIcons = decorateEditorContextMenus(codeEditor);
		if (isEditorViewState(mount.viewState)) codeEditor.restoreViewState(mount.viewState);
		const threads = mount.review ? attachReviewThreads(codeEditor, setReviewZones) : null;
		const commenting = threads
			? attachReviewCommenting(codeEditor, threads, mount.commentLabels)
			: null;
		threadsRef.current = threads;
		commentingRef.current = commenting;
		const userNavigated = () => latestRef.current.onUserNavigated?.();
		const userEvents = ["wheel", "pointerdown", "keydown"] as const;
		// Capture phase: Monaco's scrollbar stops wheel events before they bubble to the container.
		for (const type of userEvents)
			container.addEventListener(type, userNavigated, { passive: true, capture: true });
		return () => {
			for (const type of userEvents)
				container.removeEventListener(type, userNavigated, { capture: true });
			clearFlash(flashRef);
			const saved = codeEditor.saveViewState();
			if (saved) latestRef.current.onViewState?.(saved);
			menuIcons.dispose();
			commenting?.dispose();
			threads?.dispose();
			threadsRef.current = null;
			commentingRef.current = null;
			editorRef.current = null;
			decorationsRef.current = [];
			disposeFileEditor(codeEditor);
		};
	}, []);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		const applied = appliedRef.current;
		if (
			!codeEditor ||
			(applied.scope === scope && applied.path === path && applied.text === text)
		) {
			return;
		}
		syncFileModel(codeEditor, { scope, path, text }, applied.text);
		appliedRef.current = { ...applied, scope, path, text };
	}, [scope, path, text]);

	useLayoutEffect(() => {
		commentingRef.current?.setLabels(commentLabels);
	}, [commentLabels]);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor || appliedRef.current.options === options) return;
		appliedRef.current = { ...appliedRef.current, options };
		codeEditor.updateOptions(options);
	}, [options]);

	useEffect(() => remeasureEditorFonts(font), [font]);

	const closeComposer = () => threadsRef.current?.closeComposer();
	const returnFocus = (line?: number) => {
		const codeEditor = editorRef.current;
		if (!codeEditor) return;
		if (line !== undefined) codeEditor.setPosition({ lineNumber: line, column: 1 });
		codeEditor.focus();
	};
	const layoutReviewZones = () => threadsRef.current?.layout();

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		const freshMount = freshMountRef.current;
		freshMountRef.current = false;
		if (!review || !codeEditor) return;
		threadsRef.current?.setThreads(review.threads);
		decorationsRef.current = applyReviewDecorations(
			codeEditor,
			decorationsRef.current,
			review.threads,
		);
		const line = focusLine(review);
		if (line === null) return;
		if (freshMount) revealLineNow(codeEditor, line);
		else codeEditor.revealLineInCenter(line);
		const focus = review.focus;
		if (focus?.moveFocus) focusCommentCardWhenRendered(() => containerRef.current, focus.id);
		review.onFocusHandled();
	}, [review]);

	const revealLine = reveal?.line;
	const revealColumn = reveal?.column;
	const revealLength = reveal?.length;
	const revealTick = reveal?.tick;
	const revealFlash = reveal?.flash === true;
	const revealHandled = useEffectEvent((tick: number) => onRevealHandled?.(tick));
	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor || revealLine === undefined || revealTick === undefined) return;
		revealLineNow(codeEditor, revealLine);
		const column = revealColumn ?? 1;
		codeEditor.setSelection({
			startLineNumber: revealLine,
			startColumn: column,
			endLineNumber: revealLine,
			endColumn: column + (revealLength ?? 0),
		});
		if (revealFlash) flashLine(codeEditor, flashRef, revealLine);
		revealHandled(revealTick);
	}, [revealLine, revealColumn, revealLength, revealFlash, revealTick]);

	return (
		<>
			<div ref={containerRef} data-focus-default className="h-full w-full text-left" />
			<MonacoReviewZones
				zones={reviewZones}
				review={review}
				onCloseComposer={closeComposer}
				onReturnFocus={returnFocus}
				onRendered={layoutReviewZones}
			/>
		</>
	);
}
