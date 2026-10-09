import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const fileSchema = z.object({
  sourceRepository: z.string().min(1),
  baseRef: z.string().min(1),
  repositoryProfile: z.string().min(1),
  runRoot: z.string().min(1),
  trustedRoot: z.string().min(1),
  sandboxImage: z.string().min(1),
  vllm: z.object({
    endpointEnvironmentVariable: z.string().min(1),
    modelId: z.string().min(1),
  }),
  attemptTimeoutSeconds: z.number().int().positive(),
  standards: z.array(z.string().min(1)).min(1),
});

export interface FactoryConfiguration {
  readonly sourceRepository: string;
  readonly baseRef: string;
  readonly repositoryProfile: string;
  readonly runRoot: string;
  readonly trustedRoot: string;
  readonly sandboxImage: string;
  readonly endpoint: string;
  readonly modelId: string;
  readonly attemptTimeoutMs: number;
  readonly standards: readonly string[];
}

export async function loadConfiguration(path: string, environment: NodeJS.ProcessEnv): Promise<FactoryConfiguration> {
  const absolutePath = resolve(path);
  const parsed = fileSchema.parse(JSON.parse(await readFile(absolutePath, "utf8")));
  const endpoint = environment[parsed.vllm.endpointEnvironmentVariable];
  if (!endpoint) {
    throw new Error(`Required endpoint variable ${parsed.vllm.endpointEnvironmentVariable} is not set`);
  }
  const directory = resolve(absolutePath, "..");
  return {
    sourceRepository: resolve(directory, parsed.sourceRepository),
    baseRef: parsed.baseRef,
    repositoryProfile: resolve(directory, parsed.repositoryProfile),
    runRoot: resolve(directory, parsed.runRoot),
    trustedRoot: resolve(directory, parsed.trustedRoot),
    sandboxImage: parsed.sandboxImage,
    endpoint,
    modelId: parsed.vllm.modelId,
    attemptTimeoutMs: parsed.attemptTimeoutSeconds * 1_000,
    standards: parsed.standards.map((standard) => resolve(directory, standard)),
  };
}
