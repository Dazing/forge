import { createAgentHandoff } from "../../infrastructure/agent-runtime/handoff.js";
import { z } from "zod";

// Implementation stage message contract. The agent reports a Conventional Commit subject plus a short body of completed changes
// and observed verification; command evidence stays in the stage log. The runner validates transport and reserved metadata,
// never the truth of the prose.

/** Upper bound on a stage message, sized to leave room for runner-owned commit trailers. */
export const MAX_MESSAGE_CHARS = 4000;

/** Control characters other than line feed are rejected in stage messages. */
const safeMessage = z.string()
  .trim()
  .min(1)
  .max(MAX_MESSAGE_CHARS)
  .regex(/^[^\x00-\x09\x0B-\x1F\x7F]*$/, "message contains control characters other than line feed")
  .regex(/^(?![\s\S]*(^|\n)Factory-[A-Za-z][A-Za-z-]*:)[\s\S]*$/, "message contains a runner-reserved commit trailer");

export const implementSchema = z.strictObject({ message: safeMessage });

/** Validated implementation stage result. */
export type ImplementStageResult = z.infer<typeof implementSchema>;

export const implementHandoff = createAgentHandoff(
  "Submit the implementation summary only after the ticket is complete and verification passes.",
  implementSchema,
);
