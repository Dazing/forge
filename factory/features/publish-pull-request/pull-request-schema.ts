import { createAgentHandoff } from "../../infrastructure/agent-runtime/handoff.js";
import { z } from "zod";

// Draft pull-request content contract: title and body only; commit instructions are obsolete.

export const MAX_BODY_CHARS = 5000;

export const pullRequestSchema = z.strictObject({ title: z.string().min(1).max(200), body: z.string().min(1).max(MAX_BODY_CHARS) });

export const pullRequestHandoff = createAgentHandoff(
  "Submit the final draft pull-request title and Markdown body after read-only content preparation.",
  pullRequestSchema,
);
