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
  `options.service` (embedder's delegation service), `worktreeRoot`, `canDeliver`, `onChange(snapshot)`,
  `store` (a `SwarmStore`, see Durability) and `onStoreError`.
- `swarmMemberExtension` — the curated-child extension giving members their board tools; inert in any
  child that is not a member. The embedder adds it to its child set; the fallback service adds it itself.
- `Swarm`, `Board`, snapshot/member/post types, `detectGates` / `runGates`, the git helpers
  (`createWorktree`, `worktreeDiff`, `applyPatch`, `commitWorktree`, `removeWorktree`, ownership globs)
  reused by the host's inbound A2A endpoint.
- `SwarmStore` (`load()` → `missing | ok | corrupt`, `save(state)`, `clear()`), `SwarmState` (the durable board),
  `createFileSwarmStore(file)` (atomic file implementation), `parseSwarmState`, `Swarm.restore(state, deps)`,
  `Swarm.resume(name)`.
- `runGates(commands, cwd, { signal, timeoutMs, runner })`: `runner` (`GateRunner`, with `ExecResult`) replaces the
  default `shell: true` child, so a host can confine gate processes (the factory's OS sandbox) without pi-swarm
  importing one; a runner that throws fails that gate with the error text. `dependencyTargets(worktree)` lists the
  real folders the worktree's `node_modules` links point to.

## Tools

Coordinator (parent session): `swarm_start` (title, gates, review, isolation, setup), `swarm_add` (name,
brief = task/owns/avoid/done, kind worker|verifier|scout|reviewer or a named `definition`, `model`,
`count` for a numbered pool `@name-1..n` addressable as `@name`, `a2a_agent`), `swarm_post`,
`swarm_board`, `swarm_status`, `swarm_diff`, `swarm_land`, `swarm_remove`, `swarm_resume`, `swarm_finish`; plus the
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
  under `worktreeRoot`; the coordinator's uncommitted state (including work landed from other members) is committed on the branch first as its baseline — built in a throwaway index, never the user's — so dependent workers see landed contracts and their own diff excludes them. It is passed to the core as a `WorkspaceProvider` cwd; `node_modules` folders within
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

## Durability

The embedder injects a `SwarmStore` per parent session; pi-swarm never chooses a path or a data dir
(ThinkRail's store is `<dataDir>/swarms/<workspaceId>/<sessionId>.json`, see the server agent spec).

- **What is stored.** One `SwarmState` (version 1): swarm id, title, status, config, every member (brief,
  ownership globs, kind, model, worktree path/branch/base, phase, gate/ownership/review results, changed
  files, landed, fix rounds, A2A task/context ids, read cursor), every post, and the coordinator's read cursor.
  Live sessions, timers, in-flight runs, `activity` and an unprocessed `swarm_done` claim are not.
- **When it is written.** Every board change schedules one write per tick; `dispose()` writes it once more.
  `createFileSwarmStore` writes a temp file and renames it over the board, so a host stop leaves the previous
  board whole, never a half-written one. A failed write goes to `onStoreError`, never stops the swarm, and is
  retried by the next change. A finished swarm stays stored until a new `swarm_start` replaces it.
- **Reading it back.** `load()` validates the whole file (version, member and post shapes, contiguous post
  numbers, cursors, and `landed` being a boolean when present: a string would read as true in `remove()` and
  skip its unlanded-changes refusal); a file that fails is moved to `<file>.corrupt` (evidence, not deleted)
  and reads as `corrupt`. The owner restores a stored board at `session_start` when the swarm tools are enabled and the
  board's parent session id matches; a missing, corrupt, foreign or unrestorable board starts no swarm and is
  reported through `onStoreError`.
- **Restored means paused.** `Swarm.restore` runs nothing: no child is created, no model is called, no member or
  coordinator is woken, and the quiet-swarm monitor stays silent while any member is restored. Every live member
  becomes `paused` with `restored: true`; a member caught mid-pipeline (`gating`/`reviewing`) returns to
  `working` (its claim is gone); a member whose worktree directory vanished also gets `worktreeMissing: true`
  and cannot be resumed, only removed (its branch is kept unless `force` is passed). Removed members stay
  `killed`. A system post on the board says what was restored.
- **Re-attaching.** A live session cannot be restored, so a restored member is started again by
  `swarm_resume [name]` (no name = every restorable member): a **fresh** child in the member's own existing
  worktree (never a new one) with its definition, kind and model, told that the host restarted, to inspect its
  worktree and carry on, plus the posts it had not read. Its earlier conversation is gone; its files and the
  board are not. A2A members resume by sending the stored task/context ids to the remote agent. A post to a
  restored member waits unread until it is resumed (`swarm_post` says so). A member removed while its resume is
  still creating the child stays removed: the resume refuses and closes the late child. The coordinator chat's own history is
  pi's session and needs nothing here.

## Boundary

Allowed: `pi-delegation`, `pi-subagents` (definitions, mapping) and `@thinkrail/pi-a2a` through their
barrels; the pi SDK and `typebox` as peers; `node:*`. Forbidden: any other `@thinkrail/*` package. The
web pane lives in `apps/web/src/swarm` ([[submodule-web-swarm]]), fed by the host's `swarm.*` wire.

## Not yet

Moving a waiting member to another model, per-member conversations in the pane, and streaming board updates to
A2A members are later phases.

## Verification

`bun test` in-package: board addressing/groups/unread cursors, ownership globs, and an end-to-end run on
pi's faux provider in a temp git repo — worktree creation, a worker writing a file, `swarm_done`,
ownership + gates + reviewer, coordinator wake, landing and worktree removal. `store.test.ts`: store round
trip, the write cut off before the rename, a failing store, corrupt/partial/unsupported files, and restore
semantics (paused, nothing started, missing worktree, resume into the same worktree with the unread posts).
