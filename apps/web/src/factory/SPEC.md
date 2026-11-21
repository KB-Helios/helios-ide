---
id: submodule-web-factory
type: submodule-design
status: active
title: Factory — the workspace's durable DAGs, their gates and decisions
parent: module-web
depends-on: [module-contracts]
references: [module-pi-dag]
tags: [dag, factory, multi-agent]
---

## Responsibility

A chat-header **Factory** trigger and pane for the workspace's durable DAGs ([[module-pi-dag]],
[[submodule-server-agent]] DAG owner). It appears once the host reports at least one DAG for the
workspace and shows the DAG list (title, mode, how many gates wait for you) and, for the selected DAG:

- **Waiting for you** — each pending gate with its question. An approval gate has **Approve** (the reason
  is optional and defaults to a localized note) and **Reject** (a reason is required, as pi-dag requires
  one); an input gate takes a text answer. This is the done-when of the factory roadmap step: a decision
  needs no chat.
- **Start a run** — a collapsed **Start a run** form (host v135): the task, **Planner** or **One coder** as
  the splitter, and a model per role from `dag.roles` (**Automatic (…)** leaves the choice to the host; only
  an actual pick is sent). A reviewer in the coder's vendor family (`reviewerSharesFamily`, judged on the
  family the host reports) needs the explicit **Allow a reviewer from the coder's model family** switch; the
  host records that in the run and refuses it otherwise, so the form never sends it silently. The run is
  created **paused** and selected: starting work stays your Resume. A Planner run is a planning DAG: its
  planner's `plan` output is readable in the step's Output viewer, its approval is an ordinary human gate
  under **Waiting for you**, and once the planner step completed the pane offers **Create factory run**
  (`dag.startFromPlan`, which the host re-checks). Multi-coder plans are the planner's or the wire's
  (`dag.start` `coders`); the form itself only offers one coder.
- **Graph** — a collapsible drawing of the DAG above the Steps list: steps as boxes (id plus the status word,
  border colour as a second channel) in columns by their longest dependency chain, joined by curved dependency
  edges. `layoutDag` in `graphLayout.ts` is a pure layered layout (columns by depth, rows ordered by the average
  row of their dependencies to limit crossings, unknown or repeated edges ignored, cycle-safe) with no graph
  library; the pane scrolls it when wider than itself. It is a picture of what Steps already lists, so it is one
  `role="img"` with a summary and the list stays the accessible, actionable view. Uses design tokens only
  (`bg-container-elevated-bg`, `border-*`, `currentColor` strokes); no inline colours.
- **Steps** — every node with glyph + word + colour status, its task preview and what it runs after;
  nodes that need a person (waiting, needs attention, uncertain, stale) are listed first.
- **Resume / Pause** for the DAG as a whole, plus **Interrupt** (while it runs) and **Cancel workflow**. Both ask
  once more (the first press arms the button, the second sends); so do the per-step controls below.
- **Step controls** — what pi-dag accepts for the step's state, from `nodeActions` in `factoryModel.ts`:
  **Continue** an interrupted step's own attempt, **Retry step** (a new attempt; it discards the step's and its
  successors' results, hence the confirm) for an interrupted, cancelled, needs-attention or stale step, and
  **Cancel step** for queued, running or interrupted work. `nodeCommand` builds the whitelisted wire command from
  the attempt and activation the host reported; a step that never ran has no control.
- **Output** — a step that has submitted lists its declared output names; picking one reads it with `dag.output`
  into a bounded viewer (the host cuts at 64 KiB and says so; a file output is only described).
- **History** — a collapsed list of the DAG's events (kind, step, which kind of caller, time) read on demand from
  `dag.history` in pages with **Load more**. Rows are a manifest: no event body or path.
- **Worker slots** — one line under the description, `Workers: running of limit · queued`, shown only while
  a turn runs or waits and in the warning colour when every slot is taken and work waits. It is the
  host's `dag.queue` (the workspace-wide cap across all DAGs); a node waiting for a slot reads `Queued` in
  Steps. `queueLine` in `factoryModel.ts` is the projection. From v136 a second line (`All workspaces: …`) appears only
  when the host's machine-wide cap is full and holds work back.
- **Run log** — each node that ran shows its model (and thinking level), tokens in/out, cost and, when it
  did not complete, how it ended; the DAG header shows the totals. All of it is pi-dag's persisted outcome
  projected by the host, never computed here.
- **Replan** — a factory DAG whose `release` (or `review`) a person rejected shows `Replan with this feedback`
  (`replanReady` in `factoryModel.ts`, from the node's `rejected` flag). It calls `dag.replan` and selects the
  new planning DAG, titled `Replan: …`, which is paused: the person resumes the planner, approves its plan and
  builds the factory run as for any plan. It is not destructive, so it has no second press; the host's refusal
  (not a factory DAG, a run it cannot recover) is shown as written. Only the factory's own steps offer it: a
  rejected plan is retried in place.
- **Reviewer findings** — a gate on a reviewer node shows the findings count, model and list (most
  serious first) from `dag.review`, so the decision to release is made with the findings in view. A
  review the host could not read is shown as unfinished, never as zero findings.

## Rules

- The host is the authority and the UI is only a projection: `DagView` carries no storage paths,
  captured-file references or consumed values. The pane never infers state; a command's result is the
  host's re-read of the DAG.
- The wire carries no authority. `dag.execute` always acts as the local human on the host, so nothing
  here can become another caller and nothing a chat model does can approve a human gate.
- Every command carries the `expectedVersion` the pane last read and a fresh `commandId`. A stale version
  (`DAG_STALE`) is shown as "changed in the meantime", the pane re-reads and the user decides again;
  any other refusal (`DAG_REJECTED`) is shown without detail.
- `useFactory` reads `dag.list` once per connection and re-reads on each `dag.changed` for this
  workspace. From `DAG_PUSH_PROTOCOL_VERSION` (v133) the host pushes every committed change of a DAG
  (worker admission and settlement, gates, controller and wire commands; debounced), so the pane never
  polls. Only a host older than v133, which pushes after wire commands alone, is re-read every 5 seconds
  while the pane is open. The trigger itself only reads on connect and on push.
- A host older than `DAG_PROTOCOL_VERSION` hides the surface; one older than `DAG_REVIEW_PROTOCOL_VERSION`
  shows it without the run log and findings, one older than `DAG_QUEUE_PROTOCOL_VERSION` without the
  worker-slots line, and one older than `DAG_DETAILS_PROTOCOL_VERSION` (v134) without output and history, and one older than
  `DAG_START_PROTOCOL_VERSION` (v135) without the start form (the trigger then still needs a DAG to appear), and one
  older than `DAG_REPLAN_PROTOCOL_VERSION` (v137) without the replan action.
- Not here yet: creating or editing a DAG, skip/steer/reconcile and manual result acceptance.
- Pure derivations (dependency lookup, node ordering, pending total) live in `factoryModel.ts` and are
  unit tested.
