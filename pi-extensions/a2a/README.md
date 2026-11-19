# @thinkrail/pi-a2a

A [pi](https://pi.dev) extension for the [Agent2Agent (A2A)](https://a2a-protocol.org) protocol: `a2a_agents`, `a2a_send` and `a2a_task` let the agent discover remote A2A agents and delegate self-contained tasks to them. Configure agents in `a2a.json` in your pi agent folder:

```json
{ "agents": { "reviewer": { "url": "https://agents.example.com", "bearerTokenEnv": "REVIEWER_TOKEN" } } }
```

The package also exports an A2A client and `createA2AHandler`, a transport-neutral JSON-RPC server handler for hosts that expose their own agent.
