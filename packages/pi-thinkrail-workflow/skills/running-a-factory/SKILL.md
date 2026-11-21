---
name: running-a-factory
description: "Use when large, already-designed implementation work splits into independent parts that should be built in parallel and be gated, independently reviewed and released by a person — ThinkRail's AI factory — or when the user asks about a factory run, its plan, its review or its results."
---

# Running a Factory

The AI factory is ThinkRail's gated, parallel implementation line: a planner splits the work, coders build
the parts in their own git worktrees, the host runs the repository's own gates in an OS sandbox, a
reviewer from a different model family reads the diffs, **a person releases**, and only then does the
host land the result on the target branch. This workflow is how you propose a run, hand it over, and read
the results back. You never start, approve, release or land one.

## What you can and cannot do

- **A person starts a run** in the app: the chat header's **Factory** pane, **Start a run** (the task, a
  **Planner** or **One coder** splitter, a model per role). The run is created paused and starts on the
  person's **Resume**.
- **A person approves** the plan (planner step) and, separately, the release. Those gates are human-only.
  `dag_decide` is a controller tool: it cannot decide them, and you must not try to route around that.
- **You can read** every run in the workspace with `dag_read` (`list`, `get`, `output`, `history`).
- **Do not build a factory DAG yourself.** `dag_create` can express one, but the factory's roles, ownership
  checks, gate budget and reviewer come from the pane's template; a hand-written definition skips them, and
  the host's landing check refuses it anyway without a human release. Use `dag_create` only for plain
  DAGs the person asked for.
- **Never claim** a plan was approved, a release given or anything landed unless `dag_read` shows that
  gate `approved` by a human and the node `completed`. Report state as observed.

## When to propose a run

Propose it only when all hold; otherwise build serially or fan out per **choosing-a-workflow**:

- The design is settled (a task-spec or an explicit request) and the work is large.
- It splits into parts that touch **different files** and need nothing from each other's output while
  running: each coder works alone in its own worktree.
- The repository declares `typecheck`, `lint` or `test` scripts the gates can run, the project is trusted,
  and the work needs neither network nor installs (gates run with no network).
- The person wants a reviewed, human-released result, not a conversation with the agents.

Say why in one or two lines and let them decide. A declined proposal ends here; build it another way.

## Write the plan

Draft it, show it, then hand it over. Put it in the chat and save it to
`.thinkrail/context/factory-plan.md` (a temp doc, overwritten next time) so the person can paste it.

- **Task.** Goal and done-when for the whole run, the relevant spec ids, constraints, and which commands
  must pass. The planner is read-only and sees only the repository, not this chat.
- **One entry per coder** (at most 8): a short id (lower-case letters, digits and dashes, starting with a
  letter), a self-contained task (at most 8000 characters), and `owns` globs.
- **Disjoint `owns`.** With several coders every one needs `owns`, and no two may overlap; the host
  rejects the plan otherwise. A file several parts need (a barrel, a locale catalog, a shared type) goes
  to exactly one coder, or the work is not parallel. `avoid` globs fence off the rest.
- **Build files stay protected.** `package.json`, lockfiles, `Cargo.toml` and similar are refused to a coder
  unless its `owns` names them; give them to one coder deliberately.
- **Spec first.** If a part changes a boundary, amend the owning spec before the run, not inside it.

## Hand it over

Tell the person to open **Factory**, **Start a run**, paste the task, and pick **Planner** (it proposes the
coders from your brief) or **One coder**. Name what they will be asked: approve the plan, **Create factory
run**, **Resume**, then release after the review. Then stop; do not poll in a loop.

## Reading results

When the person asks, or returns after the run, `dag_read` `list`, then `get` the run. Report per step:
status, gate verdicts (`gate-<coder>` records command, exit code and a reason), the reviewer's findings
(`output` `findings`), and what waits on them. Name any gate that failed or refused to run (untrusted
project, no declared gate, ownership violation, no sandbox) as its own finding.

## After a rejection

A rejected plan or release keeps its step blocked with the person's reason. Read it (`dag_read`
`history`), tell the person what it points at, and propose the change: a narrower task, different `owns`,
or a spec fix. Retrying a step and approving again are the person's controls in the pane. Do not resume,
retry or edit the run unless they explicitly ask you to in chat.

## Ending

This workflow ends once the plan is handed over or the person has declined it. When they come back with
results or a rejection, re-enter at **Reading results** or **After a rejection**. A landed result then
enters **shipping-a-pr** if the person asks for a PR.
