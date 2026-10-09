import { chmod, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  it("clones a fixed baseline and passes host-controlled build and behavior checks", async () => {
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
      standards: [resolve("standards/inventory-api-skill.md")],
    };
    const workspaceAdapter = new GitWorkspace({ workspaceRoot: join(root, "workspaces") });
    const workspace = await workspaceAdapter.prepare(request);
    const verifier = new TrustedVerification({ stateRoot: join(root, "trusted") });

    const result = await verifier.preflight(request, workspace);

    expect(result.passed, result.reason).toBe(true);
    expect(result.checks.map((check) => check.exitCode)).toEqual([0, 0]);
  }, 180_000);
});
