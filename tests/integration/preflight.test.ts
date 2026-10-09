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

describe("real sample preflight", () => {
  it("clones a fixed baseline and executes candidate acceptance against its read-only copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-preflight-"));
    temporaryDirectories.push(root);
    const source = join(root, "source");
    await materializeFixture(resolve("."), "proof/scenarios/feature.json", source);
    const ticketPath = resolve("samples/tickets/feature.md");
    const request: RunRequest = {
      runId: "preflight-integration",
      ticket: parseTicket(ticketPath, await readFile(ticketPath, "utf8")),
      repository: {
        sourcePath: source,
        baseRef: "main",
        outputBranch: "factory/preflight-integration",
        profilePath: resolve("config/sample-repository.json"),
      },
      model: { provider: "vllm", modelId: "not-used", endpoint: "http://127.0.0.1:8000/v1" },
      attemptTimeoutMs: 30_000,
      standards: [resolve("standards/skills/inventory-api")],
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
    await Promise.all([
      writeFile(join(candidate, "manifest.json"), JSON.stringify({
        schemaVersion: 1,
        tests: [{
          id: "missing-reservations",
          file: "missing-reservations.json",
          criteria,
          rationale: "The absent reservation endpoint must produce intentional RED on the original baseline.",
        }],
      }), "utf8"),
      writeFile(join(candidate, "missing-reservations.json"), JSON.stringify({
        id: "missing-reservations",
        criteria,
        steps: [{
          method: "POST",
          path: "/reservations",
          json: { sku: "WIDGET", quantity: 1 },
          expect: { status: 201 },
        }],
      }), "utf8"),
    ]);
    const validation = await verifier.validateCandidate(request, workspace, {
      status: "completed",
      stage: "test-design",
      criteria: criteria.map((id) => ({
        id,
        verdict: "unmet" as const,
        evidence: ["POST /reservations is absent from the baseline."],
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
  }, 180_000);
});
