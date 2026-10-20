import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWaitRegistry } from "../herdr/waits.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerWorktreeTools } from "./tools/worktree.js";
import { registerPaneTools } from "./tools/pane.js";
import { registerAgentQueryTools } from "./tools/agent-query.js";
import { registerAgentTranscriptTools } from "./tools/agent-transcript.js";
import { registerModelTools } from "./tools/models.js";
import { registerAgentPromptTools } from "./tools/agent-prompt.js";
import { registerAgentControlTools } from "./tools/agent-control.js";
import { registerWaitTools } from "./tools/wait.js";
import { registerAgentHealthTools } from "./tools/agent-health.js";
import { registerMachineTools } from "./tools/machine.js";
import { registerSessionTools } from "./tools/session.js";
import { registerTabTools } from "./tools/tab.js";

/**
 * The cowbell tool surface — a 1:1 mapping onto the canonical herdr
 * specs. Every tool body is: validate -> build spec -> runHerdr.
 * No ad-hoc command strings anywhere.
 *
 * EVERY tool carries the optional transport params (`machine` |
 * `remote`); the default is ALWAYS the local herdr session. Remote
 * workspaces and agents do not appear in the local UI — callers opt
 * in per call.
 *
 * Composition root only: each per-domain registrar lives in
 * src/mcp/tools/<domain>.ts (moved verbatim from this file). The
 * call order below IS the tool registration order — keep it stable.
 */

function buildServer(): McpServer {
  const server = new McpServer({ name: "cowbell", version: "0.1.0" });
  registerWorkspaceTools(server);
  registerWorktreeTools(server);
  registerPaneTools(server);
  registerAgentQueryTools(server);
  registerAgentTranscriptTools(server);
  registerModelTools(server);
  registerAgentPromptTools(server);
  registerAgentControlTools(server);
  registerWaitTools(server, createWaitRegistry());
  registerMachineTools(server);
  registerSessionTools(server);
  registerTabTools(server);
  registerAgentHealthTools(server);
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
