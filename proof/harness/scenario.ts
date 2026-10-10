import { z } from "zod";

export const proofScenarioSchema = z.object({
  id: z.string().min(1),
  fixture: z.string().min(1),
  ticket: z.string().min(1),
  skills: z.array(z.string().min(1)).min(1),
  evaluator: z.string().min(1),
  expectedSolution: z.string().min(1),
}).strict();

export type ProofScenario = z.infer<typeof proofScenarioSchema>;
