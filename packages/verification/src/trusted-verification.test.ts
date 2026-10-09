import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    treeExcludes: [".git"],
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
    model: { provider: "openai-subscription", modelId: "gpt-6-luna" },
    attemptTimeoutMs: 5_000,
    skills: {
      shared: [],
      byRole: {
        "test-design": [], implementation: [], refactor: [], review: [],
        "acceptance-correction": [], repair: [], "re-review": [], "pull-request": [],
      },
    },
  };
  const workspace = { path: workspacePath, baseCommit: "base-commit", branch: "solution/run-1" };
  const verifier = new TrustedVerification({ stateRoot: join(root, "host-owned") });
  return { root, workspace, request, verifier };
}

function report(): StageReport {
  return {
    kind: "authoring",
    status: "completed",
    stage: "test-design",
    operation: "test-design",
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
  expectations: readonly Record<string, unknown>[] = [{
    criteria: ["AC-1"],
    target: `${testId} observable result`,
    provenance: {
      kind: "ticket",
      source: "AC-1",
      rationale: "The ticket defines the expected observable result.",
    },
    distinguishingInput: "The scenario request",
    expectedResult: "The asserted response",
    rejects: "An implementation that omits the required behavior",
    materialAlternative: false,
    derived: false,
    ambiguity: "resolved",
  }],
): Promise<void> {
  const candidate = join(fixtureValue.workspace.path, ".factory", "acceptance");
  await writeFile(join(candidate, "acceptance-suite.json"), JSON.stringify({
    schemaVersion: 2,
    tests: [{
      id: testId,
      file: "scenario.json",
      criteria: ["AC-1"],
      rationale: "Exercises the ticket behavior through the public boundary.",
    }],
    expectations,
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

  it("accepts external scratch work without changing protected identity and freezes a revalidated corrected suite", async () => {
    const value = await fixture("feature");
    await writeCandidate(value, failingAssertion);
    await value.verifier.preflight(value.request, value.workspace);
    const firstValidation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    const first = await value.verifier.freezeSuite(firstValidation);
    await writeFile(join(value.workspace.path, "application.txt"), "partially implemented production\n", "utf8");
    const protectedIdentity = await value.verifier.captureProtectedContentIdentity(value.workspace);
    const scratch = join(value.root, "host-scratch");
    await mkdir(scratch);
    await writeFile(join(scratch, "probe.mjs"), "console.log('probe')");
    await writeCandidate(value, { ...failingAssertion, correctionMarker: "corrected" });

    const correction = await value.verifier.validateCorrection(
      value.request,
      value.workspace,
      report(),
      first,
      protectedIdentity,
    );
    const second = await value.verifier.freezeSuite(correction);

    expect(correction.accepted).toBe(true);
    expect(correction.checks).toEqual([expect.objectContaining({ command: "trusted-acceptance", exitCode: 1 })]);
    expect(await value.verifier.captureProtectedContentIdentity(value.workspace)).toEqual(protectedIdentity);
    expect(second.version).not.toBe(first.version);
    expect(second.digest).not.toBe(first.digest);
    expect(await readFile(join(first.path, "scenario.json"), "utf8")).not.toContain("corrected");
    expect(await readFile(join(second.path, "scenario.json"), "utf8")).toContain("corrected");
  });

  it.each(["added", "modified", "deleted"] as const)("rejects %s protected content with paths, identities, policy and suite binding", async (change) => {
    const value = await fixture("feature");
    await writeCandidate(value, failingAssertion);
    await value.verifier.preflight(value.request, value.workspace);
    const firstValidation = await value.verifier.validateCandidate(value.request, value.workspace, report());
    const first = await value.verifier.freezeSuite(firstValidation);
    const protectedIdentity = await value.verifier.captureProtectedContentIdentity(value.workspace);
    const changedPath = change === "added" ? ".factory/probe/helper.mjs" : "application.txt";
    if (change === "added") {
      await mkdir(join(value.workspace.path, ".factory/probe"), { recursive: true });
      await writeFile(join(value.workspace.path, changedPath), "console.log('probe')");
    } else if (change === "modified") {
      await writeFile(join(value.workspace.path, changedPath), "correction changed production\n", "utf8");
    } else {
      await rm(join(value.workspace.path, changedPath));
    }
    await writeCandidate(value, { ...failingAssertion, correctionMarker: "changed-production" });

    const correction = await value.verifier.validateCorrection(
      value.request,
      value.workspace,
      report(),
      first,
      protectedIdentity,
    );

    expect(correction.accepted).toBe(false);
    expect(correction.passed).toBe(false);
    expect(correction.checks).toEqual([]);
    expect(correction.reason).toContain(`${change} ${changedPath}`);
    expect(correction.reason).toContain(first.version);
    expect(correction.reasonCode).toBe("correction-boundary-violation");
    expect(correction.diagnostics).toEqual({
      policy: "protected-workspace-content",
      exclusions: [".git", ".factory/acceptance", ".factory/verification-runtime"],
      beforeIdentity: protectedIdentity.digest,
      afterIdentity: (await value.verifier.captureProtectedContentIdentity(value.workspace)).digest,
      added: change === "added" ? [changedPath] : [],
      modified: change === "modified" ? [changedPath] : [],
      deleted: change === "deleted" ? [changedPath] : [],
      binding: {
        runId: value.request.runId,
        ticketDigest: value.request.ticket.digest,
        baseCommit: value.workspace.baseCommit,
        suiteVersion: first.version,
        suiteDigest: first.digest,
      },
    });
    await expect(value.verifier.freezeSuite(correction)).rejects.toThrow();
  });

  it("rejects unresolved material expectation ambiguity before freeze", async () => {
    const value = await fixture("feature");
    await writeCandidate(value, failingAssertion, "AC1_behavior", [{
      criteria: ["AC-1"],
      target: "AC1_behavior status",
      provenance: { kind: "assumption", source: "not specified", rationale: "A guess would be required." },
      distinguishingInput: "valid request",
      expectedResult: "201",
      rejects: "200",
      materialAlternative: true,
      ambiguity: "unresolved",
      derived: false,
    }]);
    await value.verifier.preflight(value.request, value.workspace);

    const validation = await value.verifier.validateCandidate(value.request, value.workspace, report());

    expect(validation.accepted).toBe(false);
    expect(validation.reason).toMatch(/material ambiguity/i);
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
