import { z } from "zod";

/**
 * Response contracts for the opencode background-service HTTP API
 * (`GET /api/session/{sessionID}/message` — operation
 * session.message.list, documented by /openapi.json).
 *
 * Two layers, both zod, repo style:
 *
 *   1. RAW schemas validate what the API actually returns
 *      ({data: [...], cursor: {...}}). `.passthrough()` everywhere:
 *      the API is an external surface that grows fields — a new
 *      key must not break transcript reads; a missing contract key
 *      (id, time.created, a known type) must.
 *
 *   2. The NORMALIZED transcript view cowbell exposes: user and
 *      assistant turns as first-class entries (text, reasoning,
 *      tool name + status), other documented message types
 *      (system, synthetic, idle, agent-switched, ...) as compact
 *      event entries carrying their text/detail. Not exposed: full
 *      tool inputs, provider state, metadata.
 *
 * The message TYPE union is pinned by the drift fixture, not by a
 * hard enum here — an undocumented new type degrades to an event
 * entry instead of failing the read; the drift suite still fires.
 */

/** Documented types (Session.Message.Info union in /openapi.json). */
export const MESSAGE_TYPES = [
  "user",
  "assistant",
  "system",
  "synthetic",
  "idle",
  "agent-switched",
  "model-switched",
  "location-switched",
  "skill",
  "shell",
] as const;

// -- raw API response --------------------------------------------------------

const rawTime = z.object({ created: z.number() }).passthrough();

const rawModel = z
  .object({ id: z.string(), providerID: z.string() })
  .passthrough();

const rawMessage = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    time: rawTime,
    text: z.string().optional(),
    agent: z.string().optional(),
    model: rawModel.optional(),
    content: z.array(z.object({ type: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export const messagesEnvelopeSchema = z
  .object({
    data: z.array(rawMessage),
    cursor: z
      .object({ previous: z.string().nullable().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RawMessage = z.output<typeof rawMessage>;

// -- raw API response (model discovery) ---------------------------------------
//
// GET /api/model (model.list) → {data: Model.Info[]}
// GET /api/model/default (model.default) → {data: Model.Info | null}
//
// Same two-layer discipline as the transcript: `.passthrough()` so a
// new upstream field cannot break discovery, while the keys the
// normalized view needs (id, modelID, providerID, name, variants[].id
// — all required by Model.Info today, pinned by the models drift
// fixture) must be present.

const rawVariant = z.object({ id: z.string().min(1) }).passthrough();

const rawModelInfo = z
  .object({
    id: z.string().min(1),
    modelID: z.string().min(1),
    providerID: z.string().min(1),
    name: z.string(),
    variants: z.array(rawVariant),
  })
  .passthrough();

export const modelsEnvelopeSchema = z
  .object({ data: z.array(rawModelInfo) })
  .passthrough();

export const modelDefaultEnvelopeSchema = z
  .object({ data: rawModelInfo.nullable() })
  .passthrough();

export type RawModelInfo = z.output<typeof rawModelInfo>;

// -- normalized transcript view ----------------------------------------------

const messagePartSchema = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("reasoning"), text: z.string() }).strict(),
  z
    .object({ type: z.literal("tool"), name: z.string(), status: z.string() })
    .strict(),
  z.object({ type: z.string() }).strict(),
]);

export const transcriptMessageSchema = z
  .object({
    id: z.string().min(1),
    /** "user" | "assistant" for turns; any documented event type. */
    role: z.string().min(1),
    created: z.number(),
    streamed: z.number().optional(),
    agent: z.string().optional(),
    model: rawModel.optional(),
    text: z.string().optional(),
    parts: z.array(messagePartSchema),
    /** Compact event context (outcome, previous agent, model id, ...). */
    detail: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type TranscriptMessage = z.output<typeof transcriptMessageSchema>;

export const transcriptPageSchema = z
  .object({
    messages: z.array(transcriptMessageSchema),
  })
  .strict();
export type TranscriptPage = z.output<typeof transcriptPageSchema>;

// -- normalized models view ----------------------------------------------------

/**
 * The trimmed model view models_list exposes: the full selector
 * string agent_start's `model` param wants (and `opencode -m`
 * accepts), the provider, display name, variant ids, and whether
 * this entry is the service default. Not exposed: cost, limits,
 * capabilities, provider settings — discovery, not cataloging.
 */
const modelEntrySchema = z
  .object({
    /** Selector for agent_start model / `-m`: "providerID/modelID". */
    model: z.string().min(1),
    provider: z.string().min(1),
    name: z.string(),
    /** Variant ids; append as "#variant" to the selector when used. */
    variants: z.array(z.string().min(1)),
    /** True on exactly the entry matching the service default. */
    default: z.boolean(),
  })
  .strict();

export const modelsResultSchema = z
  .object({
    models: z.array(modelEntrySchema),
    /**
     * The default selector — also flagged inside `models`. Null when
     * the service has no default configured.
     */
    default: z.string().min(1).nullable(),
  })
  .strict();
export type ModelsResult = z.output<typeof modelsResultSchema>;
