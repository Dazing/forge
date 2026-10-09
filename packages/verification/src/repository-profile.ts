import { realpath, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const commandSchema = z.object({
  id: z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  executable: z.string().min(1),
  args: z.array(z.string()),
  timeoutMs: z.number().int().positive().max(60 * 60 * 1_000),
  testResults: z.boolean().default(false),
  expectedFailureExitCode: z.number().int().positive().optional(),
}).strict();

const relativePathSchema = z.string().min(1).refine((value) => {
  if (isAbsolute(value)) return false;
  const normalized = value.replaceAll("\\", "/");
  return normalized !== ".." && !normalized.startsWith("../") && !normalized.includes("/../");
}, "must be a relative path contained by its owning directory");

const profileSchema = z.object({
  schemaVersion: z.literal(1),
  protectedRunnerConfig: z.string().min(1),
  acceptance: z.object({
    candidateDirectory: relativePathSchema,
    manifestFile: relativePathSchema,
    integrationDirectory: relativePathSchema,
    command: commandSchema,
  }).strict(),
  baselineChecks: z.array(commandSchema).min(1),
  stageChecks: z.object({
    implementation: z.array(commandSchema),
    refactor: z.array(commandSchema),
    review: z.array(commandSchema),
  }).strict(),
  finalChecks: z.array(commandSchema),
  treeExcludes: z.array(relativePathSchema).default([".git"]),
}).strict();

export type TrustedCommand = z.infer<typeof commandSchema>;
export type RepositoryProfile = z.infer<typeof profileSchema>;

export interface LoadedRepositoryProfile {
  readonly path: string;
  readonly protectedRunnerConfig: string;
  readonly profile: RepositoryProfile;
}

export async function loadRepositoryProfile(
  profilePath: string,
  workspacePath: string,
): Promise<LoadedRepositoryProfile> {
  const [resolvedProfile, resolvedWorkspace] = await Promise.all([
    realpath(resolve(profilePath)),
    realpath(resolve(workspacePath)),
  ]);
  assertOutside(resolvedProfile, resolvedWorkspace, "Repository profile");

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(resolvedProfile, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read trusted repository profile ${resolvedProfile}`, { cause: error });
  }

  const parsed = profileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Invalid trusted repository profile ${resolvedProfile}: ${z.prettifyError(parsed.error)}`);
  }
  const profile = parsed.data;
  const protectedRunnerConfig = await realpath(resolve(dirname(resolvedProfile), profile.protectedRunnerConfig));
  assertOutside(protectedRunnerConfig, resolvedWorkspace, "Protected runner configuration");
  const runnerStat = await stat(protectedRunnerConfig);
  if (!runnerStat.isFile()) {
    throw new Error(`Protected runner configuration is not a regular file: ${protectedRunnerConfig}`);
  }
  const acceptanceExecutable = await realpath(profile.acceptance.command.executable);
  assertOutside(acceptanceExecutable, resolvedWorkspace, "Trusted acceptance runner");
  profile.acceptance.command.executable = acceptanceExecutable;

  const commands = [
    ...profile.baselineChecks,
    ...profile.stageChecks.implementation,
    ...profile.stageChecks.refactor,
    ...profile.stageChecks.review,
    ...profile.finalChecks,
    profile.acceptance.command,
  ];
  for (const command of commands) {
    validateDirectCommand(command);
  }
  if (!profile.acceptance.command.testResults) {
    throw new Error("The trusted acceptance command must declare testResults: true");
  }
  if (profile.acceptance.command.expectedFailureExitCode === undefined) {
    throw new Error("The trusted acceptance command must declare expectedFailureExitCode");
  }
  for (const requiredPlaceholder of ["{runnerConfig}", "{workspace}", "{suite}"]) {
    if (!profile.acceptance.command.args.some((argument) => argument.includes(requiredPlaceholder))) {
      throw new Error(`Trusted acceptance command must pass ${requiredPlaceholder} directly to the protected runner`);
    }
  }

  return { path: resolvedProfile, protectedRunnerConfig, profile };
}

export function resolveContained(root: string, relativePath: string, label: string): string {
  const result = resolve(root, relativePath);
  const relation = relative(resolve(root), result);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes its owning directory: ${relativePath}`);
  }
  return result;
}

function validateDirectCommand(command: TrustedCommand): void {
  if (!isAbsolute(command.executable)) {
    throw new Error(`Trusted command ${command.id} executable must be an absolute path`);
  }
  const executableName = command.executable.split(/[\\/]/).at(-1)?.toLowerCase();
  if (executableName === "sh" || executableName === "bash" || executableName === "zsh" || executableName === "cmd.exe" || executableName === "powershell" || executableName === "pwsh") {
    throw new Error(`Trusted command ${command.id} cannot delegate execution to a shell`);
  }
  if (command.expectedFailureExitCode !== undefined && !command.testResults) {
    throw new Error(`Trusted command ${command.id} cannot define an expected failure exit code without test results`);
  }
}

function assertOutside(candidate: string, root: string, label: string): void {
  const relation = relative(root, candidate);
  const isOutside = relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
  if (!isOutside) {
    throw new Error(`${label} must be outside the agent-writable workspace`);
  }
}
