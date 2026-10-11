import { z } from "zod";

// Draft pull-request content contract: title and body only; commit instructions are obsolete.

export const pullRequestSchema = z.strictObject({ title: z.string().min(1).max(200), body: z.string().min(1).max(5000) });
