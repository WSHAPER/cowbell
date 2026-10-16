import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchModels } from "../../opencode/client.js";
import { json } from "../shared.js";

/**
 * Model discovery for agent_start's `model` param — the read-only
 * other half of typed model selection. NO transport params on
 * purpose: this queries the LOCAL opencode background service, so
 * machine/remote do not apply.
 */
export function registerModelTools(server: McpServer): void {
  server.tool(
    "models_list",
    "List models available to the LOCAL opencode service (GET /api/model + /api/model/default " +
      "via the opencode api CLI, read-only) — the discovery side of agent_start's `model` param. " +
      "Each entry carries the full `providerID/modelID` selector plus variant ids; the default " +
      "is returned at the top level and flagged on its entry. machine/remote do NOT apply: the " +
      "opencode API is local-only, so this tool takes no parameters.",
    {},
    async () => json(await fetchModels()),
  );
}
