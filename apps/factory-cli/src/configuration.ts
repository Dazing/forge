import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { SkillRole } from "@factory/core";

const fileSchema = z.object({
  sourceRepository: z.string().min(1),
  baseRef: z.string().min(1),
  repositoryProfile: z.string().min(1),
  runRoot: z.string().min(1),
  trustedRoot: z.string().min(1),
  sandboxImage: z.string().min(1),
  sandboxNetwork: z.string().min(1).optional(),
  openaiSubscription: z.object({
    authFile: z.string().min(1),
    modelId: z.string().min(1),
  }),
  attemptTimeoutSeconds: z.number().int().positive(),
  orchestrationTimeoutSeconds: z.number().int().positive().default(60),
  attemptShutdownGraceSeconds: z.number().int().positive().default(10),
  sharedSkills: z.array(z.string().min(1)).min(1),
  roleSkills: z.object({
    "test-design": z.array(z.string().min(1)).min(1),
    implementation: z.array(z.string().min(1)).min(1),
    refactor: z.array(z.string().min(1)),
    review: z.array(z.string().min(1)).min(1),
    "acceptance-correction": z.array(z.string().min(1)).min(1),
    repair: z.array(z.string().min(1)).min(1),
    "re-review": z.array(z.string().min(1)).min(1),
    "pull-request": z.array(z.string().min(1)),
  }).strict(),
});

export interface FactoryConfiguration {
  readonly sourceRepository: string;
  readonly baseRef: string;
  readonly repositoryProfile: string;
  readonly runRoot: string;
  readonly trustedRoot: string;
  readonly sandboxImage: string;
  readonly sandboxNetwork?: string;
  readonly authFile: string;
  readonly modelId: string;
  readonly attemptTimeoutMs: number;
  readonly orchestrationTimeoutMs: number;
  readonly attemptShutdownGraceMs: number;
  readonly skills: {
    readonly shared: readonly string[];
    readonly byRole: Readonly<Record<SkillRole, readonly string[]>>;
  };
}

export async function loadConfiguration(path: string): Promise<FactoryConfiguration> {
  const absolutePath = resolve(path);
  const parsed = fileSchema.parse(JSON.parse(await readFile(absolutePath, "utf8")));
  const directory = resolve(absolutePath, "..");
  return {
    sourceRepository: resolve(directory, parsed.sourceRepository),
    baseRef: parsed.baseRef,
    repositoryProfile: resolve(directory, parsed.repositoryProfile),
    runRoot: resolve(directory, parsed.runRoot),
    trustedRoot: resolve(directory, parsed.trustedRoot),
    sandboxImage: parsed.sandboxImage,
    ...(parsed.sandboxNetwork === undefined ? {} : { sandboxNetwork: parsed.sandboxNetwork }),
    authFile: resolve(directory, parsed.openaiSubscription.authFile),
    modelId: parsed.openaiSubscription.modelId,
    attemptTimeoutMs: parsed.attemptTimeoutSeconds * 1_000,
    orchestrationTimeoutMs: parsed.orchestrationTimeoutSeconds * 1_000,
    attemptShutdownGraceMs: parsed.attemptShutdownGraceSeconds * 1_000,
    skills: {
      shared: parsed.sharedSkills.map((skill) => resolve(directory, skill)),
      byRole: Object.fromEntries(Object.entries(parsed.roleSkills).map(([role, skills]) => [
        role,
        skills.map((skill) => resolve(directory, skill)),
      ])) as Record<SkillRole, string[]>,
    },
  };
}
