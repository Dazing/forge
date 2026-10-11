import { z } from "zod";

const safeText = z.string().trim().min(1).max(4000).refine((value) => !/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value), "must not contain control characters");

export const integrateSchema = z.object({
  message: safeText.refine((value) => !/^Factory-[A-Za-z-]+:/m.test(value), "must not contain runner-owned trailers"),
  conflicts: z.array(z.object({ path: z.string().trim().min(1), disposition: safeText }).strict()),
}).strict();

export type IntegrateStageResult = z.infer<typeof integrateSchema>;
