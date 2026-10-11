import { z } from "zod";

// Implementation stage message contract. The agent reports a Conventional Commit subject plus a short body of completed changes
// and observed verification; command evidence stays in the stage log. The runner validates transport and reserved metadata,
// never the truth of the prose.

/** Upper bound on a stage message, sized to leave room for runner-owned commit trailers. */
export const MAX_MESSAGE_CHARS = 4000;

/** Control characters other than line feed are rejected in stage messages. */
const controlCharacters = /[\x00-\x09\x0B-\x1F\x7F]/;

/** `Factory-*:` commit trailers are runner-owned stage identity; agent prose containing one is rejected so it cannot be forged. */
const reservedTrailers = /(^|\n)Factory-[A-Za-z][A-Za-z-]*:/;

export const implementSchema = z
  .strictObject({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) })
  .refine((value) => !controlCharacters.test(value.message), { message: "message contains control characters other than line feed" })
  .refine((value) => !reservedTrailers.test(value.message), { message: "message contains a runner-reserved commit trailer" });

/** Validated implementation stage result. */
export type ImplementStageResult = Readonly<{
  message: string;
}>;
