import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as worktrees from "../../herdr/spec-worktree.js";
import { withT, transport, text, exec } from "../shared.js";
import type { TransportParams } from "../shared.js";

export function registerWorktreeTools(server: McpServer): void {
  server.tool(
    "worktree_create",
    "Create a Git worktree and open it as a workspace (returns workspace_id + root pane_id). Note: cwd must be the repo parent/main checkout, not a linked worktree",
    withT({
      cwd: z.string().describe("Repo directory to create the worktree from"),
      branch: z.string().describe("Branch name for the new worktree"),
      base: z.string().optional().describe("Base ref (defaults to HEAD)"),
      label: z.string().optional().describe("Workspace label"),
      focus: z.boolean().optional().default(false),
    }),
    async (
      v: TransportParams & {
        cwd: string;
        branch: string;
        base?: string;
        label?: string;
        focus?: boolean;
      },
    ) =>
      text(
        await exec(
          worktrees.worktreeCreate({
            cwd: v.cwd,
            branch: v.branch,
            base: v.base,
            label: v.label,
            focus: v.focus,
          }),
          transport(v),
        ),
      ),
  );

  server.tool(
    "worktree_remove",
    "Remove a worktree checkout and close its workspace. The branch ref survives removal",
    withT({
      id: z.string().describe("Workspace id of the worktree to remove"),
      force: z.boolean().optional().default(false),
    }),
    async (v: TransportParams & { id: string; force?: boolean }) =>
      text(
        await exec(
          worktrees.worktreeRemove(v.id, v.force ?? false),
          transport(v),
        ),
      ),
  );
}
