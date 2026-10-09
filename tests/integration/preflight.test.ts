import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTicket, type RunRequest } from "@factory/core";
import { GitWorkspace } from "@factory/git-workspace";
import { TrustedVerification } from "@factory/verification";
import { materializeFixture } from "../../proof/harness/materialize-fixture.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const path of temporaryDirectories.splice(0)) {
    await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  }
});

async function makeWritable(path: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(path);
  } catch {
    return;
  }
  if (!entry.isDirectory()) {
    await chmod(path, 0o600);
    return;
  }
  await chmod(path, 0o700);
  for (const child of await readdir(path)) {
    await makeWritable(join(path, child));
  }
}

async function verifyIntentionalRed(options: {
  scenarioPath: string;
  ticketPath: string;
  runId: string;
  testId: string;
  method: string;
  path: string;
  expectedStatus: number;
  json: Record<string, unknown>;
  evidence: string;
  beforeSteps?: Array<Record<string, unknown>>;
  expectedJson?: Record<string, unknown>;
  standards?: string[];
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "factory-preflight-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  await materializeFixture(resolve("."), options.scenarioPath, source);
  const ticketPath = resolve(options.ticketPath);
  const request: RunRequest = {
    runId: options.runId,
    ticket: parseTicket(ticketPath, await readFile(ticketPath, "utf8")),
    repository: {
      sourcePath: source,
      baseRef: "main",
      outputBranch: `factory/${options.runId}`,
      profilePath: resolve("config/sample-repository.json"),
    },
    model: { provider: "openai-subscription", modelId: "gpt-6-luna" },
    attemptTimeoutMs: 30_000,
    skills: {
      shared: (options.standards ?? ["standards/skills/inventory-api"]).map((path) => resolve(path)),
      byRole: {
        "test-design": [], implementation: [], refactor: [], review: [],
        "acceptance-correction": [], repair: [], "re-review": [], "pull-request": [],
      },
    },
  };
  const workspaceAdapter = new GitWorkspace({ workspaceRoot: join(root, "workspaces") });
  const workspace = await workspaceAdapter.prepare(request);
  const verifier = new TrustedVerification({ stateRoot: join(root, "trusted") });

  const result = await verifier.preflight(request, workspace);

  expect(result.passed, result.reason).toBe(true);
  expect(result.checks.map((check) => check.exitCode)).toEqual([0, 0]);
  const candidate = join(workspace.path, ".factory", "acceptance-candidate");
  await mkdir(candidate, { recursive: true });
  const criteria = request.ticket.criteria.map(({ id }) => id);
  const caseFile = `${options.testId}.json`;
  await Promise.all([
    writeFile(join(candidate, "manifest.json"), JSON.stringify({
      schemaVersion: 2,
      tests: [{
        id: options.testId,
        file: caseFile,
        criteria,
        rationale: "The absent endpoint must produce intentional RED on the original baseline.",
      }],
      expectations: [{
        criteria,
        target: `${options.testId} final response`,
        provenance: {
          kind: "ticket",
          source: criteria.join(", "),
          rationale: "The ticket criteria define the expected public response.",
        },
        distinguishingInput: `${options.method} ${options.path}`,
        expectedResult: `status ${options.expectedStatus}`,
        rejects: "The endpoint remaining absent or returning a different contract response.",
        materialAlternative: false,
        ambiguity: "resolved",
        derived: false,
      }],
    }), "utf8"),
    writeFile(join(candidate, caseFile), JSON.stringify({
      id: options.testId,
      criteria,
      steps: [
        ...(options.beforeSteps ?? []),
        {
          method: options.method,
          path: options.path,
          json: options.json,
          expect: {
            status: options.expectedStatus,
            ...(options.expectedJson ? { json: options.expectedJson } : {}),
          },
        },
      ],
    }), "utf8"),
  ]);
  const validation = await verifier.validateCandidate(request, workspace, {
    kind: "authoring",
    status: "completed",
    stage: "test-design",
    operation: "test-design",
    criteria: criteria.map((id) => ({
      id,
      verdict: "unmet" as const,
      evidence: [options.evidence],
    })),
    evidence: ["Candidate executes against the copied baseline."],
    changedWork: "Added one declarative acceptance case.",
    unresolvedIssues: [],
  });

  expect(validation.accepted, validation.reason).toBe(true);
  expect(validation.passed, validation.reason).toBe(true);
  expect(validation.checks).toMatchObject([{
    exitCode: 1,
    discoveredTests: 1,
    skippedTests: 0,
  }]);
}

describe("real sample preflight", () => {
  it("clones the feature baseline and executes candidate acceptance against its read-only copy", async () => {
    await verifyIntentionalRed({
      scenarioPath: "proof/scenarios/feature.json",
      ticketPath: "samples/tickets/feature.md",
      runId: "preflight-integration",
      testId: "missing-reservations",
      method: "POST",
      path: "/reservations",
      expectedStatus: 201,
      json: { sku: "WIDGET", quantity: 1 },
      evidence: "POST /reservations is absent from the baseline.",
    });
  }, 180_000);

  it("preflights the VSA baseline and accepts missing PATCH as assertion RED", async () => {
    await verifyIntentionalRed({
      scenarioPath: "proof/scenarios/vsa-feature.json",
      ticketPath: "samples/tickets/vsa-feature.md",
      runId: "preflight-vsa-integration",
      testId: "missing-adjustment",
      method: "PATCH",
      path: "/reservations/00000000-0000-0000-0000-000000000001",
      json: { quantity: 7 },
      expectedStatus: 200,
      evidence: "PATCH /reservations/{id} is absent from the baseline.",
    });
  }, 180_000);

  it("preflights the allocation baseline and accepts missing PUT as assertion RED", async () => {
    await verifyIntentionalRed({
      scenarioPath: "proof/scenarios/vsa-allocation-feature.json",
      ticketPath: "samples/tickets/vsa-allocation-feature.md",
      runId: "preflight-vsa-allocation-integration",
      testId: "missing-reallocation",
      method: "PUT",
      path: "/reservations/${reservationId}/allocations",
      json: { quantity: 9, destinationPostalCode: "94105" },
      expectedStatus: 200,
      expectedJson: {
        "allocations.0.location": "SOUTH",
        "allocations.0.quantity": 7,
        "allocations.1.location": "NORTH",
        "allocations.1.quantity": 2,
      },
      beforeSteps: [{
        method: "POST",
        path: "/reservations",
        json: { sku: "widget", quantity: 4 },
        expect: { status: 201 },
        captureReservationId: "id",
      }],
      standards: [
        "standards/skills/inventory-api",
        "standards/skills/inventory-allocation-api",
      ],
      evidence: "PUT /reservations/{id}/allocations is absent from the baseline.",
    });
  }, 180_000);
});
