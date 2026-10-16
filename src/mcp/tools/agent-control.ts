import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as agents from "../../herdr/spec-agent.js";
import {
  withT,
  transport,
  text,
  exec,
  target,
  agentStartShape,
} from "../shared.js";
import type { StartParams, TargetParams, RenameParams } from "../shared.js";

export function registerAgentControlTools(server: McpServer): void {
  server.tool(
    "agent_start",
    "Start an agent in an existing pane (create a workspace first, use its root pane)",
    agentStartShape,
    async (v: StartParams) =>
      text(
        await exec(
          agents.agentStart(v.name, v.kind, v.pane, {
            timeoutMs: v.timeout_ms,
            model: v.model,
            args: v.args,
          }),
          transport(v),
        ),
      ),
  );

  server.tool(
    "agent_focus",
    "Focus an agent's pane",
    withT({ target }),
    async (v: TargetParams) =>
      text(await exec(agents.agentFocus(v.target), transport(v))),
  );

  server.tool(
    "agent_rename",
    "Rename an agent",
    withT({ target, name: z.string() }),
    async (v: RenameParams) =>
      text(await exec(agents.agentRename(v.target, v.name), transport(v))),
  );
}
