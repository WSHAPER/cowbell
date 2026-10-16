import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as workspaces from "../../herdr/spec-workspace.js";
import { withT, transport, text, exec } from "../shared.js";
import type {
  TransportParams,
  IdParams,
  CreateWorkspaceParams,
} from "../shared.js";

export function registerWorkspaceTools(server: McpServer): void {
  server.tool(
    "workspace_list",
    "List herdr workspaces (local session by default)",
    withT({}),
    async (v: TransportParams) =>
      text(await exec(workspaces.workspaceList(), transport(v))),
  );

  server.tool(
    "workspace_get",
    "Show one workspace",
    withT({ id: z.string().describe("Workspace id, e.g. w36") }),
    async (v: IdParams) =>
      text(await exec(workspaces.workspaceGet(v.id), transport(v))),
  );

  server.tool(
    "workspace_create",
    "Create a workspace (returns the root pane id)",
    withT({
      cwd: z.string().describe("Working directory on the target session"),
      label: z.string().optional(),
      focus: z.boolean().optional().default(false),
    }),
    async (v: CreateWorkspaceParams) =>
      text(
        await exec(
          workspaces.workspaceCreate({
            cwd: v.cwd,
            label: v.label,
            focus: v.focus,
          }),
          transport(v),
        ),
      ),
  );

  server.tool(
    "workspace_close",
    "Close a workspace",
    withT({ id: z.string() }),
    async (v: IdParams) =>
      text(await exec(workspaces.workspaceClose(v.id), transport(v))),
  );

  server.tool(
    "workspace_focus",
    "Focus a workspace",
    withT({ id: z.string() }),
    async (v: IdParams) =>
      text(await exec(workspaces.workspaceFocus(v.id), transport(v))),
  );
}
