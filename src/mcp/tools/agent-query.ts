import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as agents from "../../herdr/spec-agent.js";
import {
  withT,
  transport,
  text,
  exec,
  target,
  readSourceSchema,
} from "../shared.js";
import type {
  TransportParams,
  TargetParams,
  ReadAgentParams,
} from "../shared.js";

export function registerAgentQueryTools(server: McpServer): void {
  server.tool(
    "agent_list",
    "List recognized agents (local session by default)",
    withT({}),
    async (v: TransportParams) =>
      text(await exec(agents.agentList(), transport(v))),
  );

  server.tool(
    "agent_get",
    "Show one agent",
    withT({ target }),
    async (v: TargetParams) =>
      text(await exec(agents.agentGet(v.target), transport(v))),
  );

  server.tool(
    "agent_read",
    "Read an agent's terminal output (pane view: spinner/blocked states, exactly what is on screen)",
    withT({
      target,
      lines: z.number().int().min(1).max(2000).optional(),
      source: readSourceSchema.optional(),
    }),
    async (v: ReadAgentParams) =>
      text(
        await exec(
          agents.agentRead(v.target, { lines: v.lines, source: v.source }),
          transport(v),
        ),
      ),
  );
}
