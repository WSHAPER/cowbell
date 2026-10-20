import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as machines from "../../herdr/spec-machine.js";
import { text, exec } from "../glue.js";

/**
 * The saved SSH-machine registry — LOCAL by construction, so NO
 * transport params (deliberately not wrapped in withT): `--machine`
 * routes an API command to a herdr server, and herdr's own help
 * labels those groups "helpers over the socket API" — `machine` is
 * "Manage saved SSH machines", this client's saved registry.
 * machine/remote do not apply. `add`/`reconnect` are not wrapped at
 * all (interactive SSH auth flows — no sane MCP semantics).
 */
export function registerMachineTools(server: McpServer): void {
  server.tool(
    "machine_list",
    "List machines saved in the local SSH registry",
    {},
    async () => text(await exec(machines.machineList())),
  );

  server.tool(
    "machine_status",
    "Check saved machines without prompting for authentication — all machines when the label/id is omitted (saved local registry)",
    {
      label_or_id: z
        .string()
        .optional()
        .describe("Machine label or id (optional — all machines when omitted)"),
    },
    async (v: { label_or_id?: string }) =>
      text(await exec(machines.machineStatus(v.label_or_id))),
  );

  registerMachineAdminTools(server);
}

/** machine_rename/remove/enable/disable: the registry-mutation surface. */
function registerMachineAdminTools(server: McpServer): void {
  server.tool(
    "machine_rename",
    "Rename a saved SSH machine in the local registry (sets the label shown in the sidebar)",
    {
      profile_id: z.string().describe("Machine profile id"),
      label: z.string().describe("New label for the machine"),
    },
    async (v: { profile_id: string; label: string }) =>
      text(await exec(machines.machineRename(v.profile_id, v.label))),
  );

  server.tool(
    "machine_remove",
    "Remove a saved SSH machine from the local registry",
    {
      profile_id: z.string().describe("Machine profile id"),
    },
    async (v: { profile_id: string }) =>
      text(await exec(machines.machineRemove(v.profile_id))),
  );

  server.tool(
    "machine_enable",
    "Enable a saved SSH machine in the local registry",
    {
      profile_id: z.string().describe("Machine profile id"),
    },
    async (v: { profile_id: string }) =>
      text(await exec(machines.machineEnable(v.profile_id))),
  );

  server.tool(
    "machine_disable",
    "Disable a saved SSH machine in the local registry",
    {
      profile_id: z.string().describe("Machine profile id"),
    },
    async (v: { profile_id: string }) =>
      text(await exec(machines.machineDisable(v.profile_id))),
  );
}
