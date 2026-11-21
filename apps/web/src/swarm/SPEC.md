---
id: submodule-web-swarm
type: submodule-design
status: active
title: Swarm — a chat's swarm board, members and mention graph
parent: module-web
depends-on: [module-contracts]
references: [module-pi-swarm]
tags: [swarm, multi-agent]
---

## Responsibility

A chat-header **Swarm** trigger and pane for the swarm this chat coordinates ([[module-pi-swarm]], `/swarm`).
It appears only once the host reports a swarm for the chat and shows three tabs:

- **Board** — every post in order (number, sender, recipients, kind, time), searchable and filterable to
  one member's traffic.
- **Members** — the coordinator, then members grouped Active / Standing by / Retired. Each row names its
  kind, phase, model and what it is doing; expanding it shows the brief, owned paths, gate results,
  ownership violations, the reviewer's verdict and — for worktree members — the member's diff against
  its base (`swarm.diff`), so a handoff can be inspected before the coordinator lands it.
- **Graph** — who mentioned whom, links weighted by post count, with step-back / forward replay over the
  posts and a return to Live.

## Rules

- The host is the authority. `useSwarm` reads `swarm.get` once per connection and then replaces its
  component-local copy with each `swarm.changed` snapshot for this chat; there is no store copy.
- A host older than `SWARM_PROTOCOL_VERSION` hides the surface.
- A board restored after a host restart arrives as an ordinary snapshot: its members are `paused` with
  `restored` (and `worktreeMissing`) set and an error line saying why, so they show the existing paused
  warning state and the host's restore post is on the board. Resuming stays with the coordinator chat
  (`swarm_resume`); the pane has no resume control.
- State is glyph + color + word, never color alone; a failure (paused member, needs-fixes, failed gate) is
  never hidden.
- Read-only in v1: steering stays with the coordinator chat (and members' own transcripts). Talking to a
  single member, removing or landing members from the pane are later phases.
- Pure derivations (graph layout, replay, grouping, filtering, diff toning) live in `swarmModel.ts` and are
  unit tested.
