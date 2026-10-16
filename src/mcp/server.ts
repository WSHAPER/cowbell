import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentMessages } from "../herdr/messages.js";
import * as agents from "../herdr/spec-agent.js";
import * as panes from "../herdr/spec-pane.js";
import * as workspaces from "../herdr/spec-workspace.js";
import * as worktrees from "../herdr/spec-worktree.js";
import type { TransportParams } from "./transport.js";
import {
  withT,
  transport,
  text,
  json,
  exec,
  paneId,
  target,
} from "./shared.js";
import type {
  IdParams,
  CreateWorkspaceParams,
  PaneParams,
  ReadPaneParams,
  SendTextParams,
  SendKeysParams,
  RunParams,
  TargetParams,
  ReadAgentParams,
  PromptParams,
  WaitParams,
  StartParams,
  RenameParams,
  MessagesParams,
} from "./shared.js";

/**
 * The cowbell tool surface — a 1:1 mapping onto the canonical herdr
 * specs. Every tool body is: validate -> build spec -> runHerdr.
 * No ad-hoc command strings anywhere.
 *
 * EVERY tool carries the optional transport params (`machine` |
 * `remote`); the default is ALWAYS the local herdr session. Remote
 * workspaces and agents do not appear in the local UI — callers opt
 * in per call.
 */

// -- workspaces -----------------------------------------------------------

function registerWorkspaceTools(server: McpServer): void {
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

function registerWorktreeTools(server: McpServer): void {
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

// -- panes (reliable primitives) -------------------------------------------

function registerPaneTools(server: McpServer): void {
  server.tool(
    "pane_get",
    "Get pane details",
    withT({ pane: paneId }),
    async (v: PaneParams) =>
      text(await exec(panes.paneGet(v.pane), transport(v))),
  );

  server.tool(
    "pane_read",
    "Read pane terminal output (source: visible is most reliable)",
    withT({
      pane: paneId,
      lines: z.number().int().min(1).max(2000).optional(),
      source: z.enum(["visible", "recent", "recent-unwrapped"]).optional(),
    }),
    async (v: ReadPaneParams) =>
      text(
        await exec(
          panes.paneRead(v.pane, { lines: v.lines, source: v.source }),
          transport(v),
        ),
      ),
  );

  server.tool(
    "pane_send_text",
    "Type literal text into a pane WITHOUT Enter",
    withT({ pane: paneId, text: z.string() }),
    async (v: SendTextParams) =>
      text(await exec(panes.paneSendText(v.pane, v.text), transport(v))),
  );

  server.tool(
    "pane_send_keys",
    "Send key names (e.g. enter, esc) to a pane",
    withT({ pane: paneId, keys: z.array(z.string()).min(1) }),
    async (v: SendKeysParams) =>
      text(await exec(panes.paneSendKeys(v.pane, v.keys), transport(v))),
  );

  server.tool(
    "pane_run",
    "Run a command in a pane: types it AND presses Enter",
    withT({ pane: paneId, command: z.string() }),
    async (v: RunParams) =>
      text(await exec(panes.paneRun(v.pane, v.command), transport(v))),
  );
}

// -- agents ----------------------------------------------------------------

function registerAgentQueryTools(server: McpServer): void {
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
      source: z.enum(["visible", "recent", "recent-unwrapped"]).optional(),
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

/**
 * The transcript tool: reads structured opencode sessions through the
 * local opencode API (with an explicit pane_fallback contract), unlike
 * the herdr-CLI query tools above.
 */
function registerAgentTranscriptTools(server: McpServer): void {
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

function registerAgentPromptTools(server: McpServer): void {
  server.tool(
    "agent_prompt",
    "Submit a prompt to an agent (types + Enter). Prefer over send_text for agents. " +
      "deliver_when 'idle' waits for the agent to go idle first (queue-of-one: the text lands " +
      "as the agent's next input; timeout_ms guards that wait) — no queue, no state is kept.",
    withT({
      target,
      text: z.string(),
      deliver_when: z
        .enum(["now", "idle"])
        .default("now")
        .describe("now: submit immediately; idle: wait for idle, then submit"),
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

function registerAgentControlTools(server: McpServer): void {
  server.tool(
    "agent_start",
    "Start an agent in an existing pane (create a workspace first, use its root pane)",
    withT({
      name: z.string(),
      kind: z.enum(agents.AGENT_KINDS),
      pane: paneId,
      timeout_ms: z.number().int().positive().optional(),
      args: z.array(z.string().min(1)).min(1).optional(),
    }),
    async (v: StartParams) =>
      text(
        await exec(
          agents.agentStart(v.name, v.kind, v.pane, {
            timeoutMs: v.timeout_ms,
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

function buildServer(): McpServer {
  const server = new McpServer({ name: "cowbell", version: "0.1.0" });
  registerWorkspaceTools(server);
  registerWorktreeTools(server);
  registerPaneTools(server);
  registerAgentQueryTools(server);
  registerAgentTranscriptTools(server);
  registerAgentPromptTools(server);
  registerAgentControlTools(server);
  return server;
}

export async function serveStdio(): Promise<void> {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
}
