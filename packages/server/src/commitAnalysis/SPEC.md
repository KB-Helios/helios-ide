---
id: submodule-server-commit-analysis
type: submodule-design
status: draft
title: commitAnalysis — per-commit analyzer + architecture mapper
parent: module-server
depends-on: [module-contracts, submodule-server-git, submodule-server-persistence, submodule-server-log]
tags: [git, review]
---

## Responsibility

For one commit sha in a workspace, run two hidden, ephemeral, read-only delegation children in
parallel — the **commit analyzer** (intent, summary, risk flags, file notes) and the **architecture
mapper** (owning `SPEC.md` modules, boundary violations, dependency edges changed) — parse each one's
fenced JSON strictly against the `contracts` validators, and store the pair once per sha.

## Boundary

- **Owns:** `store.ts` (the `.thinkrail/context/commits/<workspaceId>.analysis.json` sidecar),
  `roles.ts` (tool sets, prompts, output contracts), `parse.ts` (fenced-JSON extraction + strict
  parsers), `commitPackage.ts` (git read of one commit + task text), `commitAnalysis.ts`
  (`createCommitAnalyzer`: per-workspace serial chain, dedupe, run, persist, publish).
- **Public surface (barrel):** `createCommitAnalyzer`, `CommitAnalyzer`, `CommitSubagentRunner`,
  `readCommitPackage`.
- **Allowed deps:** `contracts`, `shared/paths`, `shared/codedError`, `git` (`gitStatus`, `gitAsync`,
  `resolveCommitOid`, `readCommitSubject`), `persistence` (workspace lookup), `log`; `agent` for types
  only.
- **Forbidden:** `host` and every sibling feature module. The child runner, model choice, worktree
  lookup and publisher are injected by `host/commitAnalysis.ts`.

## Invariants

- A stored record is immutable: `writeAnalysisOnce` never overwrites a sha, and it keeps every raw
  entry in the sidecar verbatim, including entries that fail validation. A rebased-away sha's
  record stays and goes inert (nothing lists it).
- The sidecar fails safe. A missing file reads as empty. A file that exists but cannot be read or
  parsed, or whose top level is not `{ items: object }`, is "unreadable": `readAnalyses` returns
  nothing for it, but `writeAnalysisOnce` throws and writes nothing, so a bad file is never wiped
  or rebuilt over. The caller turns that throw into a failed analysis.
- Both children are read-only by tool set. Neither gets `bash`, so neither has a shell: no git
  writes, no arbitrary commands, no network. The tool set is what is enforced, not the prompt. Both
  children need only the current file contents, which `read` / `grep` / `find` / `ls` (and the
  `spec_*` tools for the mapper) provide; the patch is captured in-process by the host, not by a
  child running `git show`.
- The commit's subject, file names and patch are untrusted data written by someone else. Both
  system prompts say so, the rendered task labels them so, and neither child follows instructions
  found inside them. The tool set above is the backstop: a commit cannot make a child run a command.
- A record is written only when BOTH children completed and BOTH outputs validated. Anything else is a
  failed analysis: no record, a `commit.analyzed` push with `status: "failed"` and a `code`.
- Runs are serialized per workspace on one promise chain; a sha already stored, pending, or (auto
  path only) already attempted is not run again.
- Nothing here throws into its caller's path: `analyzeCommit` / `analyzeNewCommits` resolve, never
  reject. `writeAnalysisOnce` deliberately throws on an unreadable sidecar or an unsafe workspace id,
  and the analyzer converts any throw into a failed analysis. Sidecar writes are tmp-file + rename.
- A run checks the sidecar is readable before it reads the commit or resolves a model, so an unreadable
  sidecar fails with `COMMIT_ANALYSIS_SIDECAR_UNREADABLE` without spending a single model call.
- Token usage of both children is recorded against the parent chat that hosted them.

## Behavior

- **Trigger:** `host/server.ts` calls `analyzeNewCommits(workspaceId, sessionId, shas)` detached after
  `maybeAttachChangeArtifacts` resolves with the shas its reconcile committed or adopted. The auto path
  skips merge commits (`isMerge`, more than one parent: a `git merge main` inside a step would otherwise
  queue every commit it pulled in) and analyzes at most the newest `AUTO_ANALYZE_CAP` (5) of the rest;
  the others stay available through `commit.analyze`.
- **On demand:** `commit.analyze` validates the sha is in `listCommits`' range
  (`resolveListedCommit`), picks the given or first live chat as parent, and queues.
- **Stale context:** the children read the current checkout, which can be newer than the analyzed
  commit, and a record is immutable. The prompts say so (judge the patch, files are context only), and
  the record stores `checkout`, the HEAD the children could read, which the dialog shows.
- **Diff input:** `gitStatus(..., { kind: "commit", sha })` file list + one
  `git show --patch --diff-merges=first-parent` capped at 120 000 chars, so a merge's patch compares
  against the same first parent as its file list; `gitDiffFile` is not used because it returns whole
  blobs.
- **Parent chat:** a run resolves its parent chat when it starts, not when it is queued: the chat that
  triggered it if still live, else the workspace's first live chat. With none the analysis fails with
  `COMMIT_ANALYSIS_NO_SESSION`. A second request for a pending sha reuses the in-flight run.
