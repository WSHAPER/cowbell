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
