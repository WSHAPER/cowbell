import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as panes from "../../herdr/spec-pane.js";
import { withT, transport, text, exec } from "../glue.js";
import { paneId, readSourceSchema } from "../shared.js";
import type {
  PaneParams,
  ReadPaneParams,
  SendTextParams,
  SendKeysParams,
  RunParams,
} from "../shared.js";

export function registerPaneTools(server: McpServer): void {
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
      source: readSourceSchema.optional(),
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
