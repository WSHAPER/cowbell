import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as tabs from "../../herdr/spec-tab.js";
import { withT, transport, text, exec } from "../shared.js";
import type { TransportParams, IdParams } from "../shared.js";

/**
 * Workspace-scoped terminal tabs, over the socket API — same shape
 * as the workspace tools: validate -> build spec -> runHerdr, with
 * transport params (machine | remote opt-in per call).
 */
export function registerTabTools(server: McpServer): void {
  server.tool(
    "tab_list",
    "List tabs (active workspace by default)",
    withT({
      workspace: z
        .string()
        .optional()
        .describe("Workspace id whose tabs to list, e.g. w36"),
    }),
    async (v: TransportParams & { workspace?: string }) =>
      text(await exec(tabs.tabList({ workspace: v.workspace }), transport(v))),
  );

  server.tool(
    "tab_create",
    "Create a tab (with neither workspace nor cwd, the active workspace is targeted)",
    withT({
      workspace: z
        .string()
        .optional()
        .describe("Workspace id to create the tab in, e.g. w36"),
      cwd: z.string().optional().describe("Working directory for the new tab"),
    }),
    async (v: TransportParams & { workspace?: string; cwd?: string }) =>
      text(
        await exec(
          tabs.tabCreate({ workspace: v.workspace, cwd: v.cwd }),
          transport(v),
        ),
      ),
  );

  server.tool(
    "tab_get",
    "Show one tab",
    withT({ id: z.string().describe("Tab id, e.g. w36:t1") }),
    async (v: IdParams) => text(await exec(tabs.tabGet(v.id), transport(v))),
  );

  registerTabMutationTools(server);
}

/** tab_focus/rename/close: the workspace-tab state-mutation surface. */
function registerTabMutationTools(server: McpServer): void {
  server.tool(
    "tab_focus",
    "Focus a tab",
    withT({ id: z.string().describe("Tab id, e.g. w36:t1") }),
    async (v: IdParams) => text(await exec(tabs.tabFocus(v.id), transport(v))),
  );

  server.tool(
    "tab_rename",
    "Rename a tab (the label goes through verbatim — spaces included, never split)",
    withT({
      id: z.string().describe("Tab id, e.g. w36:t1"),
      label: z.string().describe("New label; may contain spaces"),
    }),
    async (v: TransportParams & { id: string; label: string }) =>
      text(await exec(tabs.tabRename(v.id, v.label), transport(v))),
  );

  server.tool(
    "tab_close",
    "Close a tab",
    withT({ id: z.string().describe("Tab id, e.g. w36:t1") }),
    async (v: IdParams) => text(await exec(tabs.tabClose(v.id), transport(v))),
  );
}
