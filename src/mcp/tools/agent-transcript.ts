import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agentMessages } from "../../herdr/messages.js";
import { withT, transport, json, target } from "../shared.js";
import type { MessagesParams } from "../shared.js";

/**
 * The transcript tool: reads structured opencode sessions through the
 * local opencode API (with an explicit pane_fallback contract), unlike
 * the herdr-CLI query tools in agent-query.ts.
 */
export function registerAgentTranscriptTools(server: McpServer): void {
  server.tool(
    "agent_messages",
    "Read an agent's structured transcript (opencode sessions via the local opencode API). " +
      "Degrades to pane text with channel: pane_fallback when no native session is available " +
      "or the API is unreachable. For the pane view use agent_read.",
    withT({
      target,
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe(
          "Max messages (structured channel); default is the API page size",
        ),
      lines: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("Pane lines to read (pane_fallback channel)"),
    }),
    async (v: MessagesParams) =>
      json(
        await agentMessages(v.target, {
          limit: v.limit,
          lines: v.lines,
          transport: transport(v),
        }),
      ),
  );
}
