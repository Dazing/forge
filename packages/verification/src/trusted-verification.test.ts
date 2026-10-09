import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunRequest, StageReport, WorkspaceReference } from "@factory/core";
import { TrustedVerification } from "./trusted-verification.js";

interface Fixture {
  readonly root: string;
  readonly workspace: WorkspaceReference;
  readonly request: RunRequest;
  readonly verifier: TrustedVerification;
}

async function fixture(kind: "feature" | "bug" | "refactor" = "feature"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "factory-verification-"));
  const workspacePath = join(root, "agent-workspace");
  const trustedPath = join(root, "trusted-config");
  await Promise.all([
    mkdir(join(workspacePath, ".factory", "acceptance"), { recursive: true }),
    mkdir(trustedPath, { recursive: true }),
  ]);
  await writeFile(join(workspacePath, "application.txt"), "original production\n", "utf8");

  const runnerPath = join(trustedPath, "runner.mjs");
  await writeFile(runnerPath, `
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const [, , mode, workspace, suite] = process.argv;
if (mode === "baseline") {
  console.log("FACTORY_TEST_RESULT=" + JSON.stringify({ discovered: 1, skipped: 0, tests: [{ id: "baseline", status: "passed" }] }));
  process.exit(0);
}
const scenario = JSON.parse(await readFile(join(suite, "scenario.json"), "utf8"));
if (scenario.mutateWorkspace) await writeFile(join(workspace, "mutated.txt"), "mutation");
if (scenario.emitSummary !== false) console.log("FACTORY_TEST_RESULT=" + JSON.stringify(scenario.summary));
process.exit(scenario.exitCode);
`, "utf8");

  const profilePath = join(trustedPath, "profile.json");
  await writeFile(profilePath, JSON.stringify({
    schemaVersion: 1,
    protectedRunnerConfig: runnerPath,
    acceptance: {
      candidateDirectory: ".factory/acceptance",
      manifestFile: "acceptance-suite.json",
      integrationDirectory: "tests/Factory.Acceptance",
      command: {
        id: "trusted-acceptance",
        executable: process.execPath,
        args: ["{runnerConfig}", "acceptance", "{workspace}", "{suite}"],
        timeoutMs: 2_000,
        testResults: true,
        expectedFailureExitCode: 1,
      },
    },
    baselineChecks: [{
      id: "baseline-tests",
      executable: process.execPath,
      args: ["{runnerConfig}", "baseline", "{workspace}", "{suite}"],
      timeoutMs: 2_000,
      testResults: true,
    }],
    stageChecks: { implementation: [], refactor: [], review: [] },
    finalChecks: [],
    treeExcludes: [".git", ".factory"],
  }, null, 2), "utf8");

  const request: RunRequest = {
    runId: "run-1",
    ticket: {
      path: "ticket.md",
      markdown: `# Ticket\nKind: ${kind}\n## Acceptance criteria\n- AC-1: required behavior\n`,
      digest: "ticket-digest",
      kind,
      criteria: [{ id: "AC-1", text: "required behavior" }],
    },
    repository: {
      sourcePath: join(root, "source"),
      baseRef: "main",
      outputBranch: "solution/run-1",
      profilePath,
    },
    model: { provider: "vllm", modelId: "local", endpoint: "http://localhost/v1" },
    attemptTimeoutMs: 5_000,
    standards: [],
  };
  const workspace = { path: workspacePath, baseCommit: "base-commit", branch: "solution/run-1" };
  const verifier = new TrustedVerification({ stateRoot: join(root, "host-owned") });
  return { root, workspace, request, verifier };
}

function report(): StageReport {
  return {
    status: "completed",
    stage: "test-design",
    criteria: [{ id: "AC-1", verdict: "met", evidence: ["AC1_behavior"] }],
    evidence: ["candidate-suite"],
    changedWork: "Added black-box acceptance coverage",
    unresolvedIssues: [],
  };
}

async function writeCandidate(
  fixtureValue: Fixture,
  scenario: Record<string, unknown>,
  testId = "AC1_behavior",
): Promise<void> {
  const candidate = join(fixtureValue.workspace.path, ".factory", "acceptance");
  await writeFile(join(candidate, "acceptance-suite.json"), JSON.stringify({
    schemaVersion: 1,
    tests: [{
      id: testId,
      file: "scenario.json",
      criteria: ["AC-1"],
      rationale: "Exercises the ticket behavior through the public boundary.",
    }],
  }), "utf8");
  await writeFile(join(candidate, "scenario.json"), JSON.stringify(scenario), "utf8");
}

const failingAssertion = {
  exitCode: 1,
  summary: {
    discovered: 1,
    skipped: 0,
    tests: [{ id: "AC1_behavior", status: "failed", failureKind: "assertion", criteria: ["AC-1"] }],
  },
};

const passing = {
  exitCode: 0,
  summary: {
    discovered: 1,
    skipped: 0,
    tests: [{ id: "AC1_behavior", status: "passed", criteria: ["AC-1"] }],
  },
};

describe("TrustedVerification", () => {
  it("accepts intentional feature RED but reports that same deliberate failure as a failed downstream gate", async () => {
    const value = await fixture("feature");
    await writeCandidate(value, failingAssertion);
    expect((await value.verifier.preflight(value.request, value.workspace)).passed).toBe(true);

    const validation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    expect(validation).toMatchObject({ accepted: true, passed: true });
    const suite = await value.verifier.freezeSuite(validation);

    const gate = await value.verifier.runChecks("implementation", value.workspace, suite);
    expect(gate.passed).toBe(false);
    expect(gate.checks.at(-1)).toMatchObject({ command: "trusted-acceptance", exitCode: 1, discoveredTests: 1 });
  });

  it("rejects an arbitrary nonzero command failure as RED evidence", async () => {
    const value = await fixture("bug");
    await writeCandidate(value, { exitCode: 2, emitSummary: false });
    await value.verifier.preflight(value.request, value.workspace);

    const validation = await value.verifier.validateCandidate(value.request, value.workspace, report());

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toMatch(/structured test result|expected RED exit code/i);
  });

  it.each([
    ["zero discovered", { exitCode: 0, summary: { discovered: 0, skipped: 0, tests: [] } }],
    ["a skipped test", { exitCode: 0, summary: { discovered: 1, skipped: 1, tests: [{ id: "AC1_behavior", status: "skipped" }] } }],
  ])("rejects %s", async (_name, scenario) => {
    const value = await fixture("refactor");
    await writeCandidate(value, scenario);
    await value.verifier.preflight(value.request, value.workspace);

    const validation = await value.verifier.validateCandidate(value.request, value.workspace, report());

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toMatch(/discover|skipped/i);
  });

  it("detects digest tampering before executing an authoritative suite", async () => {
    const value = await fixture("refactor");
    await writeCandidate(value, passing);
    await value.verifier.preflight(value.request, value.workspace);
    const validation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    const suite = await value.verifier.freezeSuite(validation);
    const scenarioPath = join(suite.path, "scenario.json");
    await chmod(suite.path, 0o755);
    await chmod(scenarioPath, 0o644);
    await writeFile(scenarioPath, JSON.stringify(failingAssertion), "utf8");

    const gate = await value.verifier.runChecks("implementation", value.workspace, suite);

    expect(gate.passed).toBe(false);
    expect(gate.reason).toMatch(/digest|tamper/i);
    expect(gate.checks).toHaveLength(0);
  });

  it("allows caller policy to replace a suite once with a correction validated on the original baseline", async () => {
    const value = await fixture("feature");
    await writeCandidate(value, failingAssertion);
    await value.verifier.preflight(value.request, value.workspace);
    const firstValidation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    const first = await value.verifier.freezeSuite(firstValidation);
    await writeFile(join(value.workspace.path, "application.txt"), "partially implemented production\n", "utf8");
    const productionIdentity = await value.verifier.captureProductionIdentity(value.workspace);
    await writeCandidate(value, { ...failingAssertion, correctionMarker: "corrected" });

    const correction = await value.verifier.validateCorrection(
      value.request,
      value.workspace,
      report(),
      first,
      productionIdentity,
    );
    const second = await value.verifier.freezeSuite(correction);

    expect(correction.accepted).toBe(true);
    expect(second.version).not.toBe(first.version);
    expect(second.digest).not.toBe(first.digest);
    expect(await readFile(join(first.path, "scenario.json"), "utf8")).not.toContain("corrected");
    expect(await readFile(join(second.path, "scenario.json"), "utf8")).toContain("corrected");
  });

  it("rejects a correction that changes production content", async () => {
    const value = await fixture("feature");
    await writeCandidate(value, failingAssertion);
    await value.verifier.preflight(value.request, value.workspace);
    const firstValidation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    const first = await value.verifier.freezeSuite(firstValidation);
    const productionIdentity = await value.verifier.captureProductionIdentity(value.workspace);
    await writeFile(join(value.workspace.path, "application.txt"), "correction changed production\n", "utf8");
    await writeCandidate(value, { ...failingAssertion, correctionMarker: "changed-production" });

    const correction = await value.verifier.validateCorrection(
      value.request,
      value.workspace,
      report(),
      first,
      productionIdentity,
    );

    expect(correction.accepted).toBe(false);
    expect(correction.reason).toMatch(/modified production/i);
  });

  it("keeps the authoritative copy unchanged by writes in agent-owned and integrated paths", async () => {
    const value = await fixture("refactor");
    await writeCandidate(value, passing);
    await value.verifier.preflight(value.request, value.workspace);
    const validation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    const suite = await value.verifier.freezeSuite(validation);
    const authoritativeBefore = await readFile(join(suite.path, "scenario.json"), "utf8");

    await writeCandidate(value, failingAssertion);
    await value.verifier.integrateSuite(value.workspace, suite);
    await chmod(join(value.workspace.path, "tests", "Factory.Acceptance"), 0o755);
    await chmod(join(value.workspace.path, "tests", "Factory.Acceptance", "scenario.json"), 0o644);
    await writeFile(join(value.workspace.path, "tests", "Factory.Acceptance", "scenario.json"), "agent tampering", "utf8");

    expect(await readFile(join(suite.path, "scenario.json"), "utf8")).toBe(authoritativeBefore);
    const finalGate = await value.verifier.verifyFinalCandidate(value.workspace, suite);
    expect(finalGate.passed).toBe(false);
    expect(finalGate.reason).toMatch(/integrated acceptance suite/i);
  });
});
