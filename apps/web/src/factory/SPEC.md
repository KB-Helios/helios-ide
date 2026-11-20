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
- **Steps** — every node with glyph + word + colour status, its task preview and what it runs after;
  nodes that need a person (waiting, needs attention, uncertain, stale) are listed first.
- **Resume / Pause** for the DAG as a whole.
- **Worker slots** — one line under the description, `Workers: running of limit · queued`, shown only while
  a turn runs or waits and in the warning colour when every slot is taken and work waits. It is the
  host's `dag.queue` (the workspace-wide cap across all DAGs); a node waiting for a slot reads `Queued` in
  Steps. `queueLine` in `factoryModel.ts` is the projection.
- **Run log** — each node that ran shows its model (and thinking level), tokens in/out, cost and, when it
  did not complete, how it ended; the DAG header shows the totals. All of it is pi-dag's persisted outcome
  projected by the host, never computed here.
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
  shows it without the run log and findings, and one older than `DAG_QUEUE_PROTOCOL_VERSION` without the
  worker-slots line.
- Not here yet: creating or editing a DAG, skip/steer/reconcile, manual result acceptance, retry and
  continue (accepted by the wire, no control in the pane), outputs and history.
- Pure derivations (dependency lookup, node ordering, pending total) live in `factoryModel.ts` and are
  unit tested.
