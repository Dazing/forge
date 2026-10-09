import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRequest } from "@factory/core";
import { GitWorkspace } from "./git-workspace.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createSourceRepository(): { path: string; baseCommit: string } {
  const path = mkdtempSync(join(tmpdir(), "git-workspace-source-"));
  temporaryDirectories.push(path);
  git(path, "init", "--initial-branch=main");
  git(path, "config", "user.name", "Test User");
  git(path, "config", "user.email", "test@example.invalid");
  writeFileSync(join(path, "tracked.txt"), "base\n");
  git(path, "add", "tracked.txt");
  git(path, "commit", "-m", "base");
  return { path, baseCommit: git(path, "rev-parse", "HEAD") };
}

function request(sourcePath: string, outputBranch = "factory/run-1"): RunRequest {
  return {
    runId: "run-1",
    ticket: {
      path: "ticket.md",
      markdown: "# Ticket",
      digest: "digest",
      kind: "feature",
      criteria: [{ id: "AC-1", text: "works" }],
    },
    repository: {
      sourcePath,
      baseRef: "main",
      outputBranch,
      profilePath: "profile.json",
    },
    model: { provider: "vllm", modelId: "model", endpoint: "http://localhost" },
    attemptTimeoutMs: 30_000,
    standards: [],
  };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("GitWorkspace", () => {
  it("preserves failed workspaces and leaves all source refs untouched before publication", async () => {
    const source = createSourceRepository();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "git-workspace-root-"));
    temporaryDirectories.push(workspaceRoot);
    const adapter = new GitWorkspace({ workspaceRoot });

    const workspace = await adapter.prepare(request(source.path));
    writeFileSync(join(workspace.path, "tracked.txt"), "staged diagnostic\n");
    git(workspace.path, "add", "tracked.txt");
    writeFileSync(join(workspace.path, "tracked.txt"), "failed work remains\n");
    writeFileSync(join(workspace.path, "untracked.txt"), "diagnostic\n");
    const snapshot = await adapter.snapshot("failed implementation");

    expect(snapshot.id).toMatch(/^[a-f0-9]{40,64}$/);
    expect(git(workspace.path, "show", ":tracked.txt")).toBe("staged diagnostic");
    expect(git(source.path, "rev-parse", "main")).toBe(source.baseCommit);
    expect(git(source.path, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
    expect(() => statSync(join(workspace.path, ".git", "objects", "info", "alternates"))).toThrow();
    expect(git(workspace.path, "remote")).toBe("");

    await expect(adapter.publishBranch("0".repeat(40))).rejects.toThrow(/base commit/i);
    await adapter.disposeExecutionResources();

    expect(readFileSync(join(workspace.path, "tracked.txt"), "utf8")).toBe("failed work remains\n");
    expect(readFileSync(join(workspace.path, "untracked.txt"), "utf8")).toBe("diagnostic\n");
    expect(git(source.path, "rev-parse", "main")).toBe(source.baseCommit);
  });

  it("publishes only the designated new branch with the exact snapshotted tree", async () => {
    const source = createSourceRepository();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "git-workspace-root-"));
    temporaryDirectories.push(workspaceRoot);
    const adapter = new GitWorkspace({ workspaceRoot });
    const workspace = await adapter.prepare(request(source.path, "factory/completed"));

    writeFileSync(join(workspace.path, "tracked.txt"), "completed\n");
    writeFileSync(join(workspace.path, "new.txt"), "new file\n");
    const snapshot = await adapter.snapshot("verified tree");
    const published = await adapter.publishBranch(source.baseCommit);

    expect(published.branch).toBe("factory/completed");
    expect(git(source.path, "rev-parse", "main")).toBe(source.baseCommit);
    expect(git(source.path, "rev-parse", "factory/completed")).toBe(published.commit);
    expect(git(source.path, "show", `${published.commit}:tracked.txt`)).toBe("completed");
    expect(git(source.path, "show", `${published.commit}:new.txt`)).toBe("new file");
    expect(git(source.path, "for-each-ref", "--format=%(refname)", "refs/heads").split("\n")).toEqual([
      "refs/heads/factory/completed",
      "refs/heads/main",
    ]);
    expect(git(source.path, "rev-list", "--min-parents=2", `${source.baseCommit}..${published.commit}`)).toBe("");
  });

  it("refuses an output branch collision without changing either source branch", async () => {
    const source = createSourceRepository();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "git-workspace-root-"));
    temporaryDirectories.push(workspaceRoot);
    const adapter = new GitWorkspace({ workspaceRoot });
    const workspace = await adapter.prepare(request(source.path, "factory/collision"));
    git(source.path, "branch", "factory/collision", source.baseCommit);
    const collisionCommit = git(source.path, "rev-parse", "factory/collision");
    writeFileSync(join(workspace.path, "tracked.txt"), "must not publish\n");

    await expect(adapter.publishBranch(source.baseCommit)).rejects.toThrow(/already exists/i);

    expect(git(source.path, "rev-parse", "main")).toBe(source.baseCommit);
    expect(git(source.path, "rev-parse", "factory/collision")).toBe(collisionCommit);
    expect(readFileSync(join(workspace.path, "tracked.txt"), "utf8")).toBe("must not publish\n");
  });

  it("never executes agent-controlled Git filters during snapshot or publication", async () => {
    const source = createSourceRepository();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "git-workspace-root-"));
    temporaryDirectories.push(workspaceRoot);
    const adapter = new GitWorkspace({ workspaceRoot });
    const workspace = await adapter.prepare(request(source.path, "factory/untrusted-metadata"));
    const marker = join(workspaceRoot, "filter-executed");
    git(workspace.path, "config", "filter.evil.clean", `sh -c 'echo compromised > ${marker}; cat'`);
    writeFileSync(join(workspace.path, ".gitattributes"), "tracked.txt filter=evil\n");
    writeFileSync(join(workspace.path, "tracked.txt"), "verified bytes\n");

    await adapter.snapshot("untrusted metadata");
    const published = await adapter.publishBranch(source.baseCommit);

    expect(() => statSync(marker)).toThrow();
    expect(git(source.path, "show", `${published.commit}:tracked.txt`)).toBe("verified bytes");
  });

  it("refuses nested Git metadata instead of publishing a gitlink", async () => {
    const source = createSourceRepository();
    const workspaceRoot = mkdtempSync(join(tmpdir(), "git-workspace-root-"));
    temporaryDirectories.push(workspaceRoot);
    const adapter = new GitWorkspace({ workspaceRoot });
    const workspace = await adapter.prepare(request(source.path, "factory/nested-git"));
    const nested = join(workspace.path, "nested");
    git(workspace.path, "init", nested);
    writeFileSync(join(nested, "payload.txt"), "verified nested content\n");

    await expect(adapter.publishBranch(source.baseCommit)).rejects.toThrow(/nested Git metadata/i);
    expect(git(source.path, "for-each-ref", "--format=%(refname)", "refs/heads")).toBe("refs/heads/main");
  });
});
