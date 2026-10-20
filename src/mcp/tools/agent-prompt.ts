import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as agents from "../../herdr/spec-agent.js";
import { withT, transport, text, exec } from "../glue.js";
import { target, deliverWhenSchema } from "../shared.js";
import type { PromptParams, WaitParams } from "../shared.js";

export function registerAgentPromptTools(server: McpServer): void {
  server.tool(
    "agent_prompt",
    "Submit a prompt to an agent (types + Enter). Prefer over send_text for agents. " +
      "deliver_when 'idle' waits for the agent to go idle first (queue-of-one: the text lands " +
      "as the agent's next input; timeout_ms guards that wait) — no queue, no state is kept.",
    withT({
      target,
      text: z.string(),
      deliver_when: deliverWhenSchema,
      wait: z.boolean().optional(),
      until: z.array(z.enum(agents.AGENT_STATUSES)).optional(),
      timeout_ms: z.number().int().positive().optional(),
    }),
    async (v: PromptParams) => {
      const specs = agents.agentPromptFlow(v.target, v.text, {
        deliverWhen: v.deliver_when,
        wait: v.wait,
        until: v.until,
        timeoutMs: v.timeout_ms,
      });
      const out: string[] = [];
      for (const s of specs) out.push(await exec(s, transport(v)));
      return text(out.join("\n"));
    },
  );

  server.tool(
    "agent_wait",
    "Block until an agent reaches a status",
    withT({
      target,
      statuses: z.array(z.enum(agents.AGENT_STATUSES)).min(1),
      timeout_ms: z.number().int().positive().optional(),
    }),
    async (v: WaitParams) =>
      text(
        await exec(
          agents.agentWait(v.target, v.statuses, v.timeout_ms),
          transport(v),
        ),
      ),
  );
}
