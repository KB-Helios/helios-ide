---
id: module-pi-a2a
type: module-design
status: draft
title: pi-a2a — Agent2Agent client tools and a transport-neutral server handler
parent: module-pi-extensions
tags: [pi-extension, a2a, interop]
---

## Responsibility

Interoperability with remote agents over the Agent2Agent protocol (JSON-RPC 2.0 binding, protocol
0.3): an installable pi extension whose tools let an agent **discover** remote agents and **delegate**
self-contained tasks to them, plus the protocol types, an HTTP client and a transport-neutral
`createA2AHandler` that a host uses to expose its own agent ([[submodule-server-host]] does).

## Public surface

- default export / `createA2AExtension({ fetch?, agentDir?, agents? })` — tools `a2a_agents` (configured
  agents with their cards, or discover one by `url`), `a2a_send` (message/send, then poll `tasks/get`
  until terminal or input-required; failed/rejected tasks throw), `a2a_task` (get, wait or cancel).
- `A2AClient` — agent-card discovery (`/.well-known/agent-card.json`, then the legacy
  `/.well-known/agent.json`, or a direct card URL), `sendMessage`, `getTask`, `cancelTask`,
  `waitForTask` with backoff and deadline.
- `createA2AHandler({ card, authorize?, sendMessage, getTask, cancelTask })` — Web `Request → Response`:
  GET card paths answer the card; POST answers JSON-RPC with A2A error codes. Streaming and push
  notification methods answer `unsupportedOperation`.
- Protocol types and helpers (`Task`, `Message`, `Artifact`, `textMessage`, `partsText`, states).

## Configuration and trust

Agents are named in `a2a.json` (`{ "agents": { "<name>": { url, description?, headers?,
bearerTokenEnv? } } }`) in the pi agent folder (personal) and, only for a trusted project,
`<cwd>/.pi/a2a.json`. A project file may add names but never shadows a personal one. Secrets are never
stored in the file: `bearerTokenEnv` names an environment variable and header values may use `${ENV}`.
Only http(s) URLs are accepted.

## Boundary

No dependencies beyond the pi SDK and `typebox` peers; `node:*` and Web standard `fetch`/`Request`/
`Response` only, so it runs under Node and Bun alike. No ThinkRail assumptions.

## Verification

`bun test`: client ↔ handler round trip over a real HTTP server (card discovery, send, poll to completion,
artifacts), bearer rejection, JSON-RPC error codes, and config precedence/trust.
