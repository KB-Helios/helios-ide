---
id: submodule-web-prompt
type: submodule-design
status: active
title: prompt — shared command-aware input behavior
parent: module-web
depends-on: [module-contracts]
tags: [ui, prompts]
---

## Responsibility

The reusable, lifecycle-neutral behavior behind command-aware prompt fields: slash parsing and matching,
keyboard/menu interaction, command-catalog normalization, race-safe prompt-template selection, and Pi-compatible
template-slot editing. Chat and pre-session workspace creation supply their own catalogs, template readers,
geometry, and submit actions; this module makes those inputs behave the same once supplied equivalent data.

## Boundary

- **Owns:** the props-driven slash menu and completion controller; pure catalog merge and command insertion;
  frontmatter stripping/template assembly; placeholder parsing, editing, mirroring, highlighting, and finalization;
  the template-pick controller that refuses to overwrite a draft changed after selection.
  The **context-token grammar** (`contextPills`): the pure parser that finds the context references a draft
  carries and the props-driven backdrop that paints them as pills.
- **Public surface:** `index.ts` is the only import path and re-exports the command-completion, template-text,
  template-pick, template-slot, context-pill, and caret/selection-restoration (`usePendingSelection`) APIs.
- **Allowed deps:** `contracts` types, React, `@thinkrail/locales` (UI strings), `@thinkrail/ui/utils` (`cn`), and `@thinkrail/ui/button` (`TemplateSlotHint` is a shared `Button`).
- **Forbidden:** store or transport access; workspace/session/project lookup; deciding which commands exist in a
  lifecycle; sending a prompt; importing `chat` or `panels`.

## Behavior

A slash token is active only at the beginning of the draft and before its first whitespace. Up/Down wrap the
visible matches; Enter/Tab selects; Escape dismisses; IME-owned key events take precedence in the consuming
input. Catalog merge is deterministic and lets the caller's more-specific later source replace a same-named
earlier source.

**Context pills.** A draft names context with plain text tokens, so the agent, history recall, the queue and a
copy/paste all see exactly what the user typed; nothing is stored beside the text. A token starts at the
beginning of the draft or after whitespace and runs to the next whitespace:

| token | kind | rule |
| --- | --- | --- |
| `@<path>` | `file` | a workspace-relative path |
| `@<path>/` | `dir` | a trailing slash |
| `@.thinkrail/context/<path>` | `artifact` | the ephemeral context scratch dir, whatever follows |
| `#<id>` | `spec` | only when `<id>` is a spec node the caller knows — `#fixme` stays text |
| `/<command>` | `skill` | the draft's first token only (pi expands a skill command only there), and only when `<command>` is a skill command the caller knows (pi names them `skill:<name>`); picking a skill from the `@` menu therefore puts it at the front of the draft, replacing a skill already there |

`findContextTokens` returns the ranges; `ContextPillBackdrop` paints each as a tinted rounded pill **behind a
transparent textarea**, the way the template-slot backdrop does, so a pill has no padding or glyph of its own
and the text metrics stay byte-identical to the textarea's (a wider pill would desynchronise the caret). The
caller owns the data: which specs and skills exist, the completion menus' candidates, and the attached-context
count (`contextTokenCount`, tokens plus nothing else — images are the caller's). `activeContextTrigger` reads
the `@` / `#` token under the caret for the caller's popover. Because a pill is text, ⌘↑ history recall, Shift+Tab
out of the composer, undo and IME composition are the textarea's own and nothing here intercepts them.

Template selection is latest-pick-wins and applies only while the draft is byte-identical to its value at pick
time and the caller's project/workspace context is unchanged. The picker exposes pending state so submit
controls stay disabled while it resolves; the draft remains editable, and an edit or context switch invalidates
the delayed application. A selected template replaces the complete draft. Tab and Shift+Tab cycle placeholders, Escape ends the
slot session, edited repeated groups mirror when leaving a slot, and submission removes untouched markers.
Presentation helpers expose the same hint and highlight states while leaving each input's layout to its owner.
`usePendingSelection` applies a requested caret/selection in a layout effect, in the same commit as the value
change and never a deferred frame: a frame landing between a follow-up select-all and its insert (a paste,
Playwright's `fill`) would collapse the selection, so the insert appends and doubles the draft.
