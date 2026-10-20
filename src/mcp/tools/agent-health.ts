// Health signal for dispatched agents — answers "is this agent actually
// making progress, or silently stalled/dead?" (fleet field report
// 2026-10-20: transport-error stalls and restart deaths were the top two
// wallclock thieves; agent_status alone cannot reveal either).
//
// OWNED BY: feat/agent-health lane. Replace this stub with the real
// implementation: pane process liveness + detected state + opencode
// transcript error tail, per the lane directive.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerAgentHealthTools(_server: McpServer): void {
  // stub — pre-registered so the fleet lane never touches server.ts
  void _server;
}
