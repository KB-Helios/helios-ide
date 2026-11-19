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
- **Public surface (barrel):** `createCommitAnalyzer`, `CommitAnalyzer`, `CommitAnalysisDeps`,
  `CommitSubagentRunner`, `readAnalysis`, `readAnalyses`, `parseCommitAnalysis`,
  `parseArchitectureImpact`, `readCommitPackage`.
- **Allowed deps:** `contracts`, `shared/paths`, `shared/codedError`, `git` (`gitStatus`, `gitAsync`,
  `resolveCommitOid`, `readCommitSubject`), `persistence` (workspace lookup), `log`; `agent` for types
  only.
- **Forbidden:** `host` and every sibling feature module. The child runner, model choice, worktree
  lookup and publisher are injected by `host/commitAnalysis.ts`.

## Invariants

- A stored record is immutable: `writeAnalysisOnce` never overwrites a sha. A rebased-away sha's
  record stays and goes inert (nothing lists it).
- A record is written only when BOTH children completed and BOTH outputs validated. Anything else is a
  failed analysis: no record, a `commit.analyzed` push with `status: "failed"` and a `code`.
- Runs are serialized per workspace on one promise chain; a sha already stored, pending, or (auto
  path only) already attempted is not run again.
- Nothing here throws into its caller's path: `analyzeCommit` / `analyzeNewCommits` resolve, never
  reject. Sidecar writes are tmp-file + rename.
- Token usage of both children is recorded against the parent chat that hosted them.

## Behavior

- **Trigger:** `host/server.ts` calls `analyzeNewCommits(workspaceId, sessionId, shas)` detached after
  `maybeAttachChangeArtifacts` resolves with the shas its reconcile committed or adopted.
- **On demand:** `commit.analyze` validates the sha is in `listCommits`' range
  (`resolveListedCommit`), picks the given or first live chat as parent, and queues.
- **Diff input:** `gitStatus(..., { kind: "commit", sha })` file list + one `git show --patch` capped
  at 120 000 chars; `gitDiffFile` is not used because it returns whole blobs.
