import { createAgentHandoff } from "../../infrastructure/agent-runtime/handoff.js";
import { z } from "zod";

// Review stage message contract. The reviewer reports a Conventional Commit subject plus a short body of findings and verification;
// command evidence stays in the stage log. The runner validates transport and reserved metadata, never the truth of the prose.

/** Upper bound on a stage message, sized to leave room for runner-owned commit trailers. */
export const MAX_MESSAGE_CHARS = 4000;

/** Control characters other than line feed are rejected in stage messages. */
const safeMessage = z.string()
  .trim()
  .min(1)
  .max(MAX_MESSAGE_CHARS)
  .regex(/^[^\x00-\x09\x0B-\x1F\x7F]*$/, "message contains control characters other than line feed")
  .regex(/^(?![\s\S]*(^|\n)Factory-[A-Za-z][A-Za-z-]*:)[\s\S]*$/, "message contains a runner-reserved commit trailer");

export const reviewSchema = z.strictObject({ message: safeMessage });

/** Validated review stage result. */
export type ReviewStageResult = z.infer<typeof reviewSchema>;

export const reviewHandoff = createAgentHandoff(
  "Submit the review summary only after all findings are resolved and verification passes.",
  reviewSchema,
);
