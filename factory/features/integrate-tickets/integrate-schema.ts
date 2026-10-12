import { createAgentHandoff } from "../../infrastructure/agent-runtime/handoff.js";
import { z } from "zod";

const safeText = z.string().trim().min(1).max(4000).regex(/^[^\u0000-\u0009\u000b-\u001f\u007f]*$/u, "must not contain control characters");

export const integrateSchema = z.object({
  message: safeText.regex(/^(?![\s\S]*^Factory-[A-Za-z-]+:)[\s\S]*$/m, "must not contain runner-owned trailers"),
  conflicts: z.array(z.object({ path: z.string().trim().min(1), disposition: safeText }).strict()),
}).strict();

export type IntegrateStageResult = z.infer<typeof integrateSchema>;

export const integrateHandoff = createAgentHandoff(
  "Submit the integration summary and every conflict disposition only after resolution and combined review pass.",
  integrateSchema,
);
