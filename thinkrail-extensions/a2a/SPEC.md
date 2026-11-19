---
id: module-ext-a2a
type: module-design
status: active
title: A2A extension — remote Agent2Agent agents for sessions and subagents
parent: module-thinkrail-extensions
depends-on: [module-extension-api, module-pi-a2a]
---

## Responsibility

Composes [[module-pi-a2a]]'s client tools (`a2a_agents`, `a2a_send`, `a2a_task`) into every parent
session and the curated child set, so subagents and swarm members can delegate to remote agents too.
Being a registry extension gives it the Settings → Extensions switch. Server half only: results are text
in the default tool card.

The host's **inbound** A2A endpoint is not part of this extension — it needs host services (workspaces,
chats, sessions) and lives in [[submodule-server-host]] (`a2aInbound.ts`).
