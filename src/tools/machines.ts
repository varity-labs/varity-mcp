import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { successResponse, errorResponse } from "../utils/responses.js";
import {
  createMachine,
  deleteMachine,
  listMachines,
  publicApiGet,
  publicApiRequest,
  VarityPublicApiError,
} from "../utils/public-api.js";
import { INFRASTRUCTURE } from "../utils/config.js";

/**
 * `varity_machines_list` / `varity_machines_create` / `varity_machines_delete`:
 * CPU virtual machines through the one public-API client (MC1). Thin wrapper:
 * the gateway (varity-gateway services/machine-public.ts) owns validation,
 * pricing and lifecycle; this module only sequences its public calls.
 *
 * - create = `POST /api/pricing/machine-quote` → `POST /api/machines` with the
 *   returned `quote_token` and an `Idempotency-Key` (8–128 chars). The caller
 *   supplies their own SSH PUBLIC key: Varity never holds a private key, so a
 *   machine created without the caller's key is unreachable to them.
 * - delete = `DELETE /api/machines/:id`, then polls `GET /api/machines/:id`
 *   until `billing.state` is `stopped` (CANON §2d: an accepted DELETE is not a
 *   stopped bill), bounded by the delete operation's own
 *   `execution_deadline_at` from the 202 (no copied budget here). An unread
 *   billing state stays `null` (unobserved); an unread deadline means one read.
 *
 * GPU machines are out of MCP scope; `execution_class` is always
 * `cpu_virtual_machine`.
 */

const EXECUTION_CLASS = "cpu_virtual_machine";
const PRIVATE_KEY_MARKER = /PRIVATE KEY|BEGIN OPENSSH|BEGIN RSA|BEGIN EC/i;
const DELETE_POLL_INTERVAL_MS = 10_000;

function apiError(err: unknown, fallbackCode: string, fallbackMessage: string) {
  if (err instanceof VarityPublicApiError) {
    return errorResponse(err.code, err.message, err.action ?? `Check ${INFRASTRUCTURE.DASHBOARD}.`);
  }
  return errorResponse(fallbackCode, fallbackMessage, "Retry the request.");
}

export interface MachineCreateInput {
  name: string;
  profile_id: string;
  os_image: string;
  ssh_public_key: string;
  additional_storage_gb?: number;
  idempotency_key?: string;
}

export async function quoteAndCreateMachine(input: MachineCreateInput) {
  const storage =
    input.additional_storage_gb === undefined ? {} : { additional_storage_gb: input.additional_storage_gb };
  const quote = await publicApiRequest<{
    quote_token: string;
    hourly_usd?: number;
    authorization_usd?: number;
    valid_until?: string;
  }>("POST", "/api/pricing/machine-quote", {
    body: { profile_id: input.profile_id, execution_class: EXECUTION_CLASS, os_image: input.os_image, ...storage },
  });
  const accepted = await createMachine(
    {
      name: input.name,
      profile_id: input.profile_id,
      execution_class: EXECUTION_CLASS,
      os_image: input.os_image,
      ...storage,
      ssh_public_key: input.ssh_public_key,
      accelerator_quote_token: quote.quote_token,
    },
    input.idempotency_key
  );
  return successResponse(
    {
      ...accepted,
      quote: { hourly_usd: quote.hourly_usd, authorization_usd: quote.authorization_usd, valid_until: quote.valid_until },
    },
    `Machine create accepted (id ${String(accepted.machine_id)}). Only the holder of the private key for the ` +
      "supplied public key can log in. It bills hourly until deleted with varity_machines_delete."
  );
}

type Sleep = (ms: number) => Promise<void>;

/** The accepted operation's `execution_deadline_at` in ms, or null when unread. */
function operationDeadlineMs(operation: unknown): number | null {
  if (operation === null || typeof operation !== "object") return null;
  const raw = (operation as Record<string, unknown>).execution_deadline_at;
  const deadline = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(deadline) ? deadline : null;
}
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function deleteAndConfirmMachine(
  machineId: string,
  idempotencyKey?: string,
  { intervalMs = DELETE_POLL_INTERVAL_MS, sleep = realSleep, now = Date.now } = {}
) {
  const accepted = await deleteMachine(machineId, idempotencyKey);
  const deadline = operationDeadlineMs(accepted.operation);
  let billingState: string | null = null;
  for (;;) {
    billingState = null;
    try {
      const detail = await publicApiGet<{ billing?: { state?: string } | null }>(
        `/api/machines/${encodeURIComponent(machineId)}`
      );
      billingState = detail.billing?.state ?? null;
    } catch (err) {
      // 404 after delete: the record is gone, so billing stays unobserved.
      if (err instanceof VarityPublicApiError && err.status === 404) break;
    }
    if (billingState === "stopped" || deadline === null || now() >= deadline) break;
    await sleep(intervalMs);
  }
  const stopped = billingState === "stopped";
  return successResponse(
    { ...accepted, billing_state: billingState, billing_stopped: stopped },
    stopped
      ? `Machine ${machineId} is deleted and its billing is stopped.`
      : `Delete accepted for machine ${machineId}, but billing stop is not confirmed ` +
          `(last billing state: ${billingState ?? "unobserved"}). Check ${INFRASTRUCTURE.DASHBOARD}.`
  );
}

export function registerMachinesTools(server: McpServer): void {
  server.registerTool(
    "varity_machines_list",
    {
      annotations: { readOnlyHint: true },
      title: "List CPU Machines",
      description:
        "List the developer's Varity CPU virtual machines with their state, SSH access and billing. " +
        "Set include_profiles to also get the CPU machine profiles and OS images (profile_id, os_image) " +
        "that varity_machines_create accepts.",
      inputSchema: {
        include_profiles: z.boolean().optional().describe("Also return the CPU machine profile catalog."),
      },
    },
    async ({ include_profiles }) => {
      try {
        const machines = await listMachines();
        const profiles = include_profiles
          ? await publicApiGet<Record<string, unknown>>(
              `/api/deployment-profiles?workload=cpu&execution_class=${EXECUTION_CLASS}`
            )
          : undefined;
        return successResponse(
          { ...machines, ...(profiles ? { profiles } : {}) },
          `${machines.machines.length} machine(s)` +
            (machines.inventory_status === "partial" ? " (inventory partial; some machines could not be read)." : ".")
        );
      } catch (err) {
        return apiError(err, "MACHINES_LIST_FAILED", "Could not list machines.");
      }
    }
  );

  server.registerTool(
    "varity_machines_create",
    {
      title: "Create a CPU Machine",
      description:
        "Create a Varity CPU virtual machine the developer can SSH into. Requires the developer's own SSH PUBLIC key " +
        "(e.g. the contents of ~/.ssh/id_ed25519.pub); never pass a private key. Get profile_id and os_image from " +
        "varity_machines_list with include_profiles. The machine bills hourly until varity_machines_delete.",
      inputSchema: {
        name: z.string().min(1).max(63).describe("Lowercase machine name, e.g. 'dev-box'."),
        profile_id: z.string().min(1).describe("CPU machine profile id (mp-...)."),
        os_image: z.string().min(1).describe("OS image id offered by that profile (os-...)."),
        ssh_public_key: z
          .string()
          .min(1)
          .refine((key) => !PRIVATE_KEY_MARKER.test(key), "This is a private key. Pass the PUBLIC key (.pub) only.")
          .describe("The developer's SSH public key, e.g. 'ssh-ed25519 AAAA... user@host'."),
        additional_storage_gb: z.number().int().min(0).optional().describe("Extra disk in GB."),
        idempotency_key: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{8,128}$/)
          .optional()
          .describe("Reuse the same key to retry a create without creating a second machine."),
      },
    },
    async (input) => {
      try {
        return await quoteAndCreateMachine(input);
      } catch (err) {
        return apiError(err, "MACHINE_CREATE_FAILED", "Could not create the machine.");
      }
    }
  );

  server.registerTool(
    "varity_machines_delete",
    {
      annotations: { destructiveHint: true },
      title: "Delete a CPU Machine and Stop Its Billing",
      description:
        "Delete a Varity CPU virtual machine by id and wait (up to 10 minutes) until its billing reads stopped.",
      inputSchema: {
        machine_id: z.string().uuid().describe("The machine id from varity_machines_list."),
        idempotency_key: z
          .string()
          .regex(/^[A-Za-z0-9._:-]{8,128}$/)
          .optional()
          .describe("Reuse the same key to retry a delete safely."),
      },
    },
    async ({ machine_id, idempotency_key }) => {
      try {
        return await deleteAndConfirmMachine(machine_id, idempotency_key);
      } catch (err) {
        return apiError(err, "MACHINE_DELETE_FAILED", `Could not delete machine ${machine_id}.`);
      }
    }
  );
}
