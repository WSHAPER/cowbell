import { z } from "zod";

/**
 * MCP-side transport parameter shared by every tool: default LOCAL;
 * exactly one of `machine` / `remote` may be given, explicitly.
 */
export const TransportSchema = z
  .object({
    machine: z
      .string()
      .optional()
      .describe("Registered machine label/id — run there"),
    remote: z
      .string()
      .optional()
      .describe("SSH target — run on a remote herdr session"),
  })
  .refine((v) => !(v.machine && v.remote), {
    message: "machine and remote are mutually exclusive",
  });

export type TransportParams = z.infer<typeof TransportSchema>;

export function toTransport(v: TransportParams | undefined) {
  return (
    pick(
      "machine",
      v?.machine,
      (label) => ({ kind: "machine", label }) as const,
    ) ??
    pick(
      "remote",
      v?.remote,
      (sshTarget) => ({ kind: "remote", sshTarget }) as const,
    )
  );
}

function pick<T, R>(
  name: string,
  value: T | undefined,
  make: (v: T) => R,
): R | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  void name;
  return make(value);
}
