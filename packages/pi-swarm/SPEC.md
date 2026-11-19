---
id: module-pi-swarm
type: module-design
status: active
title: pi-swarm — /swarm, a coordinated team of named agents on one board
parent: architecture
depends-on: [module-pi-delegation, module-pi-subagents, module-pi-a2a]
tags: [pi-extension, swarm, multi-agent]
---

## Responsibility

`/swarm <task>` turns the current conversation into the **coordinator** of a team of named members that
split a broad task, work in parallel and coordinate on **one shared, ordered @mention board**. The
coordinator hands out work, judges what comes back and reports to the user; it does not do the technical
work. Members are [[module-pi-delegation]] children (no subprocess, no second runtime); remote
Agent2Agent agents can join as members through [[module-pi-a2a]]. Portable: works under vanilla pi with
a session-scoped delegation service; ThinkRail injects its workspace service.

## Public surface (the barrel, `index.ts`)

- default export — zero-config extension (`createSwarm().extension`).
- `createSwarm(options)` → `{ extension, current(), flush(), dispose() }` — the per-parent owner.
  `options.service` (embedder's delegation service), `worktreeRoot`, `canDeliver`, `onChange(snapshot)`.
- `swarmMemberExtension` — the curated-child extension giving members their board tools; inert in any
  child that is not a member. The embedder adds it to its child set; the fallback service adds it itself.
- `Swarm`, `Board`, snapshot/member/post types, `detectGates` / `runGates`, the git helpers
  (`createWorktree`, `worktreeDiff`, `applyPatch`, `commitWorktree`, `removeWorktree`, ownership globs)
  reused by the host's inbound A2A endpoint.

## Tools

Coordinator (parent session): `swarm_start` (title, gates, review, isolation, setup), `swarm_add` (name,
brief = task/owns/avoid/done, kind worker|verifier|scout|reviewer or a named `definition`, `model`,
`count` for a numbered pool `@name-1..n` addressable as `@name`, `a2a_agent`), `swarm_post`,
`swarm_board`, `swarm_status`, `swarm_diff`, `swarm_land`, `swarm_remove`, `swarm_finish`; plus the
`/swarm` command, which sends the coordinator playbook as a user message.
Member (child session): `swarm_post`, `swarm_board`, `swarm_done`, registered at the member's first
`before_agent_start` and added to its active set.

## Semantics

- **Board.** Posts are numbered and append-only. Agent-authored posts (`brief`, `message`, `report`)
  address by `@name`, `@group` or `@all`; a member post that mentions nobody goes to `@coordinator`.
  **Gate and system notices reach only their explicit recipients** — a notice that names a member never
  wakes it (that was a wake loop: "@x paused" re-woke x, which errored again).
- **Waking.** A member's final message each turn is posted as its report. Ending a turn is sleeping: no
  tokens until a post addresses it. A post for an idle member starts one run with all its unread posts
  (batched per microtask); for a running member it is `steer`ed in. Posts for a member that is gating or
  under review wait until that finishes. The coordinator's posts are held and delivered as one
  `swarm-board` custom message with `triggerTurn` when the parent is idle (immediately, or a macrotask
  after `agent_settled`) and the embedder's `canDeliver` allows.
- **Monitor.** Deterministic, not an LLM: when every live member is asleep, nobody is mid-pipeline, the
  coordinator is idle with nothing unread and work is not done, it posts once per quiet period to
  `@coordinator`.
- **Isolation.** Workers default to their own git worktree on branch `swarm/<swarm>/<member>` from HEAD
  under `worktreeRoot`, passed to the core as a `WorkspaceProvider` cwd; `node_modules` folders within
  three levels are linked in (junctions on Windows) and **unlinked before removal** so a forced worktree
  removal can never follow them. Verifiers, scouts and reviewers share the coordinator's tree. `setup`
  commands run in each new worktree.
- **Quality before handoff.** `swarm_done` records a claim; when the member's run ends the swarm checks
  (1) ownership — changed files inside `owns` and outside `avoid`, (2) the gates (default: the project's
  `typecheck`/`lint`/`test` scripts, Cargo or Go equivalents), (3) a separate **read-only reviewer** child
  (no `edit`/`write`/`bash`) on the member's diff that must end with `VERDICT: APPROVE|CHANGES_REQUESTED`.
  Failures go back to the member; after `maxFixRounds` (3) they escalate to the coordinator. Only then is
  the member `done` and reported ready to land.
- **Landing and removal.** `swarm_land` applies the worktree's diff to the coordinator's tree uncommitted
  with an all-or-nothing `git apply` — never `--3way`, whose failed merge would leave conflict markers
  and staged entries in the user's tree; a conflict leaves the tree untouched and is reported to the
  coordinator. The parent or host owns committing. `swarm_remove` first stops
  the member, then inspects its worktree (an inspection error aborts the removal) and refuses unlanded
  changes without `force`; new work after landing clears `landed`. It then kills the child and removes the worktree (the branch is kept when it
  holds unlanded work).
- **Repo context.** Members get the definition prompt, the swarm bridge (brief, roster, protocol), project
  context files (`contextFiles: true`) and the curated child extensions (spec tools, skills, A2A). The
  coordinator playbook asks for contract-first splitting with disjoint ownership.
- **Git hygiene.** Every git call runs with `core.fsmonitor=false` and a process resolves on exit, not
  pipe close: a detached fsmonitor daemon inherits pipes and would otherwise hang the host forever.

## Boundary

Allowed: `pi-delegation`, `pi-subagents` (definitions, mapping) and `@thinkrail/pi-a2a` through their
barrels; the pi SDK and `typebox` as peers; `node:*`. Forbidden: any other `@thinkrail/*` package. The
web pane lives in `apps/web/src/swarm` ([[submodule-web-swarm]]), fed by the host's `swarm.*` wire.

## Not yet

State is in memory: a host restart loses the board (worktrees and branches survive on disk). Moving a
waiting member to another model, per-member conversations in the pane, and streaming board updates to
A2A members are later phases.

## Verification

`bun test` in-package: board addressing/groups/unread cursors, ownership globs, and an end-to-end run on
pi's faux provider in a temp git repo — worktree creation, a worker writing a file, `swarm_done`,
ownership + gates + reviewer, coordinator wake, landing and worktree removal.
