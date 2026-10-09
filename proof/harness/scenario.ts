import { z } from "zod";

export const attemptFaultSchema = z.object({
  stage: z.enum(["test-design", "implementation", "refactor", "review"]),
  attempt: z.union([z.literal(1), z.literal(2)]),
  point: z.literal("after-agent-files-changed"),
  outcome: z.literal("execution-failure"),
}).strict();

export const proofScenarioSchema = z.object({
  id: z.string().min(1),
  fixture: z.string().min(1),
  ticket: z.string().min(1),
  standards: z.array(z.string().min(1)),
  evaluator: z.string().min(1),
  expectedSolution: z.string().nullable().optional(),
  faults: z.array(attemptFaultSchema),
}).strict();
