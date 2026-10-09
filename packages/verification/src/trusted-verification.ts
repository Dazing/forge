import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type {
  AcceptanceSuite,
  CandidateValidation,
  CheckResult,
  GateResult,
  RunRequest,
  Stage,
  StageReport,
  VerificationPort,
  WorkspaceReference,
} from "@factory/core";
import {
  copyRegularDirectory,
  digestDirectory,
  makeDirectoryReadOnly,
  replaceDirectoryAtomically,
  type DirectoryDigest,
} from "./directory-integrity.js";
import {
  loadRepositoryProfile,
  resolveContained,
  type LoadedRepositoryProfile,
  type TrustedCommand,
} from "./repository-profile.js";
import { TrustedCommandRunner, type CommandExecution, type TestSummary } from "./trusted-command-runner.js";

const candidateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  tests: z.array(z.object({
    id: z.string().min(1),
    file: z.string().min(1),
    criteria: z.array(z.string().min(1)).min(1),
    rationale: z.string().min(1),
  }).strict()).min(1),
}).strict();

const immutableManifestSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string().min(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  ticketDigest: z.string().min(1),
  baseCommit: z.string().min(1),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  mapping: z.array(z.object({ criterionId: z.string(), tests: z.array(z.string()) }).strict()),
}).strict();

type CandidateManifest = z.infer<typeof candidateManifestSchema>;
type CriterionMapping = readonly { readonly criterionId: string; readonly tests: readonly string[] }[];

interface RunState {
  readonly runDirectory: string;
  readonly baselinePath: string;
  readonly baselineProductionDigest: string;
  readonly requestIdentity: string;
  readonly ticketDigest: string;
  readonly baseCommit: string;
  readonly profile: LoadedRepositoryProfile;
  readonly runner: TrustedCommandRunner;
  nextSuiteNumber: number;
  currentSuite?: AcceptanceSuite;
}

interface PendingSuite {
  readonly state: RunState;
  readonly candidatePath: string;
  readonly candidateDigest: DirectoryDigest;
  readonly mapping: CriterionMapping;
  readonly version: string;
}

export interface TrustedVerificationOptions {
  readonly stateRoot: string;
  readonly signal?: AbortSignal;
}

export class TrustedVerification implements VerificationPort {
  readonly #stateRoot: string;
  readonly #signal: AbortSignal | undefined;
  readonly #states = new Map<string, RunState>();
  readonly #pending = new WeakMap<CandidateValidation, PendingSuite>();

  constructor(options: TrustedVerificationOptions) {
    this.#stateRoot = resolve(options.stateRoot);
    this.#signal = options.signal;
  }

  async preflight(request: RunRequest, workspace: WorkspaceReference): Promise<GateResult> {
    const checks: CheckResult[] = [];
    try {
      this.#signal?.throwIfAborted();
      const workspacePath = await realpath(workspace.path);
      const stateRoot = await this.prepareStateRoot(workspacePath);
      const key = stateKey(workspacePath, request.runId);
      if (this.#states.has(key)) return failedGate(checks, `Preflight was already completed for run ${request.runId}`);
      const profile = await loadRepositoryProfile(request.repository.profilePath, workspacePath);
      const runDirectory = join(stateRoot, "runs", createHash("sha256").update(key).digest("hex"));
      await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
      try {
        await mkdir(runDirectory, { recursive: false, mode: 0o700 });
      } catch (error) {
        throw new Error(`Host-owned verification state already exists for run ${request.runId}`, { cause: error });
      }
      const baselinePath = join(runDirectory, "original-baseline");
      const evidencePath = join(runDirectory, "evidence");
      const runner = new TrustedCommandRunner(evidencePath, this.#signal);
      const candidatePath = resolveContained(workspacePath, profile.profile.acceptance.candidateDirectory, "Candidate suite directory");
      const context = {
        workspace: workspacePath,
        baseline: workspacePath,
        suite: candidatePath,
        runnerConfig: profile.protectedRunnerConfig,
        scratch: join(workspacePath, ".factory", "verification-runtime"),
      };

      for (const command of profile.profile.baselineChecks) {
        const treeId = await this.treeDigest(workspacePath, profile);
        const execution = await runner.run(command, context, workspacePath, treeId);
        checks.push(execution.check);
        const problem = greenProblem(execution);
        if (problem) return failedGate(checks, `Baseline command ${command.id} failed: ${problem}`);
      }
      await rm(context.scratch, { recursive: true, force: true });

      const productionExcludes = [
        ...profile.profile.treeExcludes,
        profile.profile.acceptance.candidateDirectory,
        ".factory/verification-runtime",
      ];
      const baselineProductionDigest = (await digestDirectory(workspacePath, {
        rejectSymlinks: false,
        excludes: productionExcludes,
      })).digest;
      await copyRegularDirectory(workspacePath, baselinePath);
      await makeDirectoryReadOnly(baselinePath);
      const state: RunState = {
        runDirectory,
        baselinePath,
        baselineProductionDigest,
        requestIdentity: requestIdentity(request),
        ticketDigest: request.ticket.digest,
        baseCommit: workspace.baseCommit,
        profile,
        runner,
        nextSuiteNumber: 1,
      };
      this.#states.set(key, state);
      return { passed: true, checks };
    } catch (error) {
      return failedGate(checks, contextualError("Verification preflight failed", error));
    }
  }

  async validateCandidate(
    request: RunRequest,
    workspace: WorkspaceReference,
    report: StageReport,
  ): Promise<CandidateValidation> {
    return this.validateCandidateAgainstOriginal(request, workspace, report, false);
  }

  async freezeSuite(validation: CandidateValidation): Promise<AcceptanceSuite> {
    const pending = this.#pending.get(validation);
    if (!pending || !validation.accepted || !validation.passed) {
      throw new Error("Only an accepted validation produced by this verifier can be frozen");
    }
    this.#signal?.throwIfAborted();
    const currentSourceDigest = await digestDirectory(pending.candidatePath, { rejectSymlinks: true });
    if (currentSourceDigest.digest !== pending.candidateDigest.digest) {
      throw new Error("Candidate acceptance suite changed after validation and cannot be promoted");
    }

    const versionRoot = join(pending.state.runDirectory, "suites", pending.version);
    const temporaryRoot = `${versionRoot}.tmp-${process.pid}-${Date.now()}`;
    const contentPath = join(temporaryRoot, "content");
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    try {
      await copyRegularDirectory(pending.candidatePath, contentPath);
      const copiedDigest = await digestDirectory(contentPath, { rejectSymlinks: true });
      if (copiedDigest.digest !== pending.candidateDigest.digest) {
        throw new Error("Candidate acceptance suite changed while it was being promoted");
      }
      const immutableManifest = {
        schemaVersion: 1 as const,
        version: pending.version,
        digest: copiedDigest.digest,
        ticketDigest: pending.state.ticketDigest,
        baseCommit: pending.state.baseCommit,
        files: copiedDigest.files,
        mapping: pending.mapping,
      };
      const serializedManifest = JSON.stringify(immutableManifest, null, 2) + "\n";
      const manifestPath = join(temporaryRoot, "suite.manifest.json");
      await writeFile(manifestPath, serializedManifest, { encoding: "utf8", mode: 0o400 });
      await makeDirectoryReadOnly(contentPath);
      await chmod(temporaryRoot, 0o555);
      await mkdir(dirname(versionRoot), { recursive: true, mode: 0o700 });
      await rename(temporaryRoot, versionRoot);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw new Error(`Cannot promote acceptance suite ${pending.version}`, { cause: error });
    }

    const suite = {
      version: pending.version,
      digest: pending.candidateDigest.digest,
      path: join(versionRoot, "content"),
    };
    pending.state.currentSuite = suite;
    this.#pending.delete(validation);
    return suite;
  }

  async runChecks(stage: Stage, workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<GateResult> {
    const checks: CheckResult[] = [];
    try {
      if (stage === "test-design") return failedGate(checks, "Test-design uses candidate validation, not downstream checks");
      const state = await this.requireState(workspace);
      const integrityProblem = await this.suiteIntegrityProblem(state, suite);
      if (integrityProblem) return failedGate(checks, integrityProblem);
      const commands = state.profile.profile.stageChecks[stage];
      const regularProblem = await this.runGreenCommands(state, workspace.path, suite, commands, checks);
      if (regularProblem) return failedGate(checks, regularProblem);
      const acceptanceProblem = await this.runAcceptanceGreen(state, workspace.path, suite, checks);
      return acceptanceProblem ? failedGate(checks, acceptanceProblem) : { passed: true, checks };
    } catch (error) {
      return failedGate(checks, contextualError(`Trusted ${stage} checks failed`, error));
    }
  }

  async captureProductionIdentity(workspace: WorkspaceReference): Promise<string> {
    const state = await this.requireState(workspace);
    return this.productionDigest(workspace.path, state);
  }

  async validateCorrection(
    request: RunRequest,
    workspace: WorkspaceReference,
    report: StageReport,
    current: AcceptanceSuite,
    productionIdentity: string,
  ): Promise<CandidateValidation> {
    const state = await this.requireState(workspace);
    if (requestIdentity(request) !== state.requestIdentity) {
      return rejectedValidation("Correction does not match the original ticket", []);
    }
    if (!state.currentSuite || state.currentSuite.version !== current.version || state.currentSuite.digest !== current.digest) {
      return rejectedValidation("Correction was not based on the current authoritative suite", []);
    }
    const integrityProblem = await this.suiteIntegrityProblem(state, current);
    const currentProductionIdentity = await this.productionDigest(workspace.path, state);
    if (currentProductionIdentity !== productionIdentity) {
      return rejectedValidation("Acceptance correction modified production content", []);
    }
    if (integrityProblem) return rejectedValidation(integrityProblem, []);

    const validation = await this.validateCandidateAgainstOriginal(request, workspace, report, true);
    if (validation.accepted && validation.passed) {
      const pending = this.#pending.get(validation);
      if (pending?.candidateDigest.digest === current.digest) {
        this.#pending.delete(validation);
        return rejectedValidation("Correction did not change the authoritative suite", validation.checks);
      }
    }
    return validation;
  }

  async integrateSuite(workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<void> {
    const state = await this.requireState(workspace);
    const integrityProblem = await this.suiteIntegrityProblem(state, suite);
    if (integrityProblem) throw new Error(integrityProblem);
    const destination = resolveContained(
      workspace.path,
      state.profile.profile.acceptance.integrationDirectory,
      "Integrated acceptance suite",
    );
    await replaceDirectoryAtomically(suite.path, destination);
    const integratedDigest = await digestDirectory(destination, { rejectSymlinks: true });
    if (integratedDigest.digest !== suite.digest) {
      throw new Error("Integrated acceptance suite does not match the authoritative suite digest");
    }
    await makeDirectoryReadOnly(destination);
  }

  async verifyPublished(workspace: WorkspaceReference, suite: AcceptanceSuite): Promise<GateResult> {
    const checks: CheckResult[] = [];
    try {
      const state = await this.requireState(workspace);
      const integrityProblem = await this.suiteIntegrityProblem(state, suite);
      if (integrityProblem) return failedGate(checks, integrityProblem);
      const destination = resolveContained(
        workspace.path,
        state.profile.profile.acceptance.integrationDirectory,
        "Integrated acceptance suite",
      );
      const integrated = await digestDirectory(destination, { rejectSymlinks: true });
      if (integrated.digest !== suite.digest) {
        return failedGate(checks, "Integrated acceptance suite does not match the authoritative copy");
      }

      const exactTreeBefore = await this.treeDigest(workspace.path, state.profile);
      const regularProblem = await this.runGreenCommands(
        state,
        workspace.path,
        suite,
        state.profile.profile.finalChecks,
        checks,
      );
      if (regularProblem) return failedGate(checks, regularProblem);
      const acceptanceProblem = await this.runAcceptanceGreen(state, workspace.path, suite, checks);
      if (acceptanceProblem) return failedGate(checks, acceptanceProblem);
      const exactTreeAfter = await this.treeDigest(workspace.path, state.profile);
      if (exactTreeAfter !== exactTreeBefore) {
        return failedGate(checks, "Final checks modified the exact output tree; tested and publishable content differ");
      }
      if (checks.some((check) => check.treeId !== exactTreeBefore)) {
        return failedGate(checks, "Final checks did not all execute against the exact same output tree");
      }
      return { passed: true, checks };
    } catch (error) {
      return failedGate(checks, contextualError("Final exact-tree verification failed", error));
    }
  }

  private async validateCandidateAgainstOriginal(
    request: RunRequest,
    workspace: WorkspaceReference,
    report: StageReport,
    correction: boolean,
  ): Promise<CandidateValidation> {
    const checks: CheckResult[] = [];
    try {
      const state = await this.requireState(workspace);
      if (requestIdentity(request) !== state.requestIdentity) {
        return rejectedValidation("Candidate does not match the original ticket used at preflight", checks);
      }
      if (report.stage !== "test-design" || report.status !== "completed") {
        return rejectedValidation("Candidate validation requires a completed test-design report", checks);
      }
      const reportCriterionIds = report.criteria.map((criterion) => criterion.id);
      const ticketCriterionIds = request.ticket.criteria.map((criterion) => criterion.id);
      if (!sameStringSet(reportCriterionIds, ticketCriterionIds)) {
        return rejectedValidation("Test-design report must address exactly every original ticket criterion", checks);
      }

      if (!correction) {
        const productionDigest = await this.productionDigest(workspace.path, state);
        if (productionDigest !== state.baselineProductionDigest) {
          return rejectedValidation("Test design changed production files from the original baseline", checks);
        }
      }
      const candidatePath = resolveContained(
        workspace.path,
        state.profile.profile.acceptance.candidateDirectory,
        "Candidate suite directory",
      );
      const candidateStat = await stat(candidatePath);
      if (!candidateStat.isDirectory()) return rejectedValidation("Candidate suite path is not a directory", checks);
      const candidateDigest = await digestDirectory(candidatePath, { rejectSymlinks: true });
      const manifestPath = resolveContained(
        candidatePath,
        state.profile.profile.acceptance.manifestFile,
        "Candidate suite manifest",
      );
      const parsedManifest = candidateManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
      if (!parsedManifest.success) {
        return rejectedValidation(`Invalid candidate suite manifest: ${z.prettifyError(parsedManifest.error)}`, checks);
      }
      const mappingResult = await validateMapping(parsedManifest.data, request, candidatePath);
      if (mappingResult instanceof Error) return rejectedValidation(mappingResult.message, checks);

      const treeId = await this.treeDigest(state.baselinePath, state.profile);
      const execution = await state.runner.run(
        state.profile.profile.acceptance.command,
        this.commandContext(state, state.baselinePath, candidatePath, workspace.path),
        state.baselinePath,
        treeId,
      );
      checks.push(execution.check);
      const candidateProblem = request.ticket.kind === "refactor"
        ? greenProblem(execution) ?? discoveredTestsProblem(
          execution.summary,
          parsedManifest.data.tests.map((test) => test.id),
        )
        : redProblem(execution, parsedManifest.data, state.profile.profile.acceptance.command);
      if (candidateProblem) return rejectedValidation(`Candidate suite did not establish valid ${request.ticket.kind === "refactor" ? "GREEN" : "RED"}: ${candidateProblem}`, checks);
      const baselineAfter = await this.treeDigest(state.baselinePath, state.profile);
      if (baselineAfter !== treeId) {
        return rejectedValidation("Candidate validation modified the original baseline", checks);
      }

      const version = `${request.runId}-suite-${state.nextSuiteNumber++}-${candidateDigest.digest.slice(0, 12)}`;
      const validation: CandidateValidation = {
        accepted: true,
        passed: true,
        suiteVersion: version,
        mapping: mappingResult,
        checks,
      };
      this.#pending.set(validation, { state, candidatePath, candidateDigest, mapping: mappingResult, version });
      return validation;
    } catch (error) {
      return rejectedValidation(contextualError("Candidate validation failed", error), checks);
    }
  }

  private async prepareStateRoot(workspacePath: string): Promise<string> {
    await mkdir(this.#stateRoot, { recursive: true, mode: 0o700 });
    const stateRoot = await realpath(this.#stateRoot);
    const relation = relative(workspacePath, stateRoot);
    const isOutside = relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation);
    if (!isOutside) {
      throw new Error("Host-owned verification state must be outside the agent-writable workspace");
    }
    return stateRoot;
  }

  private async requireState(workspace: WorkspaceReference): Promise<RunState> {
    const workspacePath = await realpath(workspace.path);
    const matches = [...this.#states.entries()].filter(([key]) => key.startsWith(`${workspacePath}\0`));
    if (matches.length !== 1) throw new Error(`No unique preflight verification state exists for workspace ${workspacePath}`);
    const state = matches[0]![1];
    if (state.baseCommit !== workspace.baseCommit) throw new Error("Workspace base commit changed after preflight");
    return state;
  }

  private commandContext(state: RunState, applicationPath: string, suitePath: string, agentWorkspace: string) {
    return {
      workspace: applicationPath,
      baseline: state.baselinePath,
      suite: suitePath,
      runnerConfig: state.profile.protectedRunnerConfig,
      scratch: join(agentWorkspace, ".factory", "verification-runtime"),
    };
  }

  private async runGreenCommands(
    state: RunState,
    workspacePath: string,
    suite: AcceptanceSuite,
    commands: readonly TrustedCommand[],
    checks: CheckResult[],
  ): Promise<string | undefined> {
    for (const command of commands) {
      const treeId = await this.treeDigest(workspacePath, state.profile);
      const execution = await state.runner.run(
        command,
        this.commandContext(state, workspacePath, suite.path, workspacePath),
        workspacePath,
        treeId,
      );
      checks.push(execution.check);
      const problem = greenProblem(execution);
      if (problem) return `Trusted command ${command.id} failed: ${problem}`;
    }
    return undefined;
  }

  private async runAcceptanceGreen(
    state: RunState,
    workspacePath: string,
    suite: AcceptanceSuite,
    checks: CheckResult[],
  ): Promise<string | undefined> {
    const treeId = await this.treeDigest(workspacePath, state.profile);
    const command = state.profile.profile.acceptance.command;
    const execution = await state.runner.run(
      command,
      this.commandContext(state, workspacePath, suite.path, workspacePath),
      workspacePath,
      treeId,
      suite.digest,
    );
    checks.push(execution.check);
    const problem = greenProblem(execution);
    if (problem) return `Authoritative acceptance suite failed: ${problem}`;
    const parsedManifest = immutableManifestSchema.parse(
      JSON.parse(await readFile(join(dirname(suite.path), "suite.manifest.json"), "utf8")) as unknown,
    );
    const expectedTests = [...new Set(parsedManifest.mapping.flatMap((entry) => entry.tests))];
    const discoveryProblem = discoveredTestsProblem(execution.summary, expectedTests);
    return discoveryProblem ? `Authoritative acceptance suite failed: ${discoveryProblem}` : undefined;
  }

  private async suiteIntegrityProblem(state: RunState, suite: AcceptanceSuite): Promise<string | undefined> {
    try {
      const suitePath = await realpath(suite.path);
      const runSuitesPath = join(state.runDirectory, "suites");
      const relation = relative(runSuitesPath, suitePath);
      if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        return "Acceptance suite is not in host-owned verification storage";
      }
      const versionRoot = dirname(suitePath);
      const parsed = immutableManifestSchema.safeParse(JSON.parse(await readFile(join(versionRoot, "suite.manifest.json"), "utf8")) as unknown);
      if (!parsed.success) return "Authoritative acceptance suite manifest is invalid or tampered";
      if (parsed.data.version !== suite.version || parsed.data.digest !== suite.digest) {
        return "Authoritative acceptance suite identity does not match its immutable manifest";
      }
      if (parsed.data.ticketDigest !== state.ticketDigest || parsed.data.baseCommit !== state.baseCommit) {
        return "Authoritative acceptance suite is bound to a different ticket or baseline";
      }
      const actual = await digestDirectory(suitePath, { rejectSymlinks: true });
      if (actual.digest !== suite.digest || JSON.stringify(actual.files) !== JSON.stringify(parsed.data.files)) {
        return "Authoritative acceptance suite digest mismatch indicates tampering";
      }
      return undefined;
    } catch (error) {
      return contextualError("Cannot verify authoritative acceptance suite digest", error);
    }
  }

  private async productionDigest(workspacePath: string, state: RunState): Promise<string> {
    return (await digestDirectory(workspacePath, {
      rejectSymlinks: false,
      excludes: [
        ...state.profile.profile.treeExcludes,
        state.profile.profile.acceptance.candidateDirectory,
        ".factory/verification-runtime",
      ],
    })).digest;
  }

  private async treeDigest(workspacePath: string, profile: LoadedRepositoryProfile): Promise<string> {
    return (await digestDirectory(workspacePath, {
      rejectSymlinks: false,
      excludes: [...profile.profile.treeExcludes, ".factory/verification-runtime"],
    })).digest;
  }
}

async function validateMapping(
  manifest: CandidateManifest,
  request: RunRequest,
  candidatePath: string,
): Promise<CriterionMapping | Error> {
  const criterionIds = new Set(request.ticket.criteria.map((criterion) => criterion.id));
  const mapped = new Map<string, string[]>(request.ticket.criteria.map((criterion) => [criterion.id, []]));
  const testIds = new Set<string>();
  for (const test of manifest.tests) {
    if (testIds.has(test.id)) return new Error(`Candidate suite contains duplicate test identifier ${test.id}`);
    testIds.add(test.id);
    const testPath = resolveContained(candidatePath, test.file, `Candidate test ${test.id}`);
    const testStat = await stat(testPath);
    if (!testStat.isFile()) return new Error(`Candidate test ${test.id} does not reference a regular file`);
    const testCriteria = new Set<string>();
    for (const criterionId of test.criteria) {
      if (testCriteria.has(criterionId)) return new Error(`Candidate test ${test.id} maps criterion ${criterionId} more than once`);
      testCriteria.add(criterionId);
      if (!criterionIds.has(criterionId)) return new Error(`Candidate test ${test.id} maps unknown criterion ${criterionId}`);
      mapped.get(criterionId)!.push(test.id);
    }
  }
  for (const [criterionId, tests] of mapped) {
    if (tests.length === 0) return new Error(`Acceptance criterion ${criterionId} is not mapped to a test`);
  }
  return [...mapped].map(([criterionId, tests]) => ({ criterionId, tests }));
}

function greenProblem(execution: CommandExecution): string | undefined {
  if (execution.processProblem) return execution.processProblem;
  if (execution.check.exitCode !== 0) return `exit code was ${execution.check.exitCode}, expected 0`;
  if (!execution.summary) return undefined;
  if (execution.summary.discovered === 0) return "zero tests were discovered";
  if (execution.summary.skipped > 0) return `${execution.summary.skipped} tests were skipped`;
  const failed = execution.summary.tests.filter((test) => test.status === "failed");
  if (failed.length > 0) return `${failed.length} tests failed despite a zero exit code`;
  return undefined;
}

function redProblem(
  execution: CommandExecution,
  manifest: CandidateManifest,
  command: TrustedCommand,
): string | undefined {
  if (execution.processProblem) return execution.processProblem;
  if (execution.check.exitCode !== command.expectedFailureExitCode) {
    return `exit code was ${execution.check.exitCode}, expected RED exit code ${command.expectedFailureExitCode}`;
  }
  const summaryProblem = testPopulationProblem(execution.summary);
  if (summaryProblem) return summaryProblem;
  const summary = execution.summary!;
  const declaredById = new Map(manifest.tests.map((test) => [test.id, test]));
  const discoveryProblem = discoveredTestsProblem(summary, [...declaredById.keys()]);
  if (discoveryProblem) return discoveryProblem;
  const failures = summary.tests.filter((test) => test.status === "failed");
  if (failures.length === 0) return "the candidate suite did not fail for missing behavior";
  for (const failure of failures) {
    if (failure.failureKind !== "assertion") return `test ${failure.id} failed for infrastructure rather than intended behavior`;
    const declared = declaredById.get(failure.id)!;
    if (!failure.criteria || failure.criteria.length === 0) return `failed test ${failure.id} did not identify its exercised criteria`;
    if (failure.criteria.some((criterion) => !declared.criteria.includes(criterion))) {
      return `failed test ${failure.id} reported criteria outside its reviewed mapping`;
    }
  }
  return undefined;
}

function testPopulationProblem(summary: TestSummary | undefined): string | undefined {
  if (!summary) return "trusted runner did not provide a structured test result";
  if (summary.discovered === 0) return "zero tests were discovered";
  if (summary.skipped > 0) return `${summary.skipped} tests were skipped`;
  return undefined;
}

function discoveredTestsProblem(summary: TestSummary | undefined, expectedTestIds: readonly string[]): string | undefined {
  if (!summary) return "trusted runner did not provide a structured test result";
  if (!sameStringSet(expectedTestIds, summary.tests.map((test) => test.id))) {
    return "discovered tests do not exactly match the reviewed acceptance manifest";
  }
  return undefined;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

function requestIdentity(request: RunRequest): string {
  return JSON.stringify({
    ticketDigest: request.ticket.digest,
    kind: request.ticket.kind,
    criteria: request.ticket.criteria.map((criterion) => ({ id: criterion.id, text: criterion.text })),
  });
}

function stateKey(workspacePath: string, runId: string): string {
  return `${workspacePath}\0${runId}`;
}

function failedGate(checks: readonly CheckResult[], reason: string): GateResult {
  return { passed: false, checks, reason };
}

function rejectedValidation(reason: string, checks: readonly CheckResult[]): CandidateValidation {
  return { accepted: false, passed: false, checks, reason };
}

function contextualError(context: string, error: unknown): string {
  return `${context}: ${error instanceof Error ? error.message : String(error)}`;
}
