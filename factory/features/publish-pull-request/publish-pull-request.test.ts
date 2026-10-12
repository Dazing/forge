import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, CommandFailedError } from "../../infrastructure/git-provider/git.js";
import type { DraftPullRequest, DraftPullRequestRequest, GitProvider } from "../../infrastructure/git-provider/git-provider.js";
import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { MissingAgentHandoffError } from "../../infrastructure/agent-runtime/handoff.js";
import type { Ticket } from "../tickets/index.js";
import { publishPullRequest, PublicationError, type PublishPullRequestInput } from "./publish-pull-request.js";
import { pullRequestSchema } from "./pull-request-schema.js";

const ticket: Ticket = {
  id: "0123456789abcdef",
  sourceHash: "source",
  requirementsHash: "requirements",
  dependsOnTickets: [],
  name: "Fix Login",
  slug: "fix-login",
  title: "Fix login",
  path: "/tickets/fix-login.md",
  content: "# Fix login\n\nRedirect after auth.",
  repository: "git@github.com:acme/app.git",
  baseBranch: "main",
};

const BRANCH = "agent-tickets/fix-login-1";

test("pull-request content accepts committed change metadata", () => {
  assert.deepEqual(pullRequestSchema.parse({ title: "Fix health endpoint", body: "Verified with curl." }), {
    title: "Fix health endpoint",
    body: "Verified with curl.",
  });
});

test("pull-request content rejects obsolete commit instructions", () => {
  assert.throws(
    () => pullRequestSchema.parse({ commitMessage: "fix: health", title: "Fix health endpoint", body: "Verified." }),
    /Unrecognized key/,
  );
});

test("pull-request content bounds title and body", () => {
  assert.equal(pullRequestSchema.safeParse({ title: "", body: "ok" }).success, false);
  assert.equal(pullRequestSchema.safeParse({ title: "x".repeat(201), body: "ok" }).success, false);
  assert.equal(pullRequestSchema.safeParse({ title: "ok", body: "y".repeat(5001) }).success, false);
});

function git(cwd: string, args: string[]): Promise<string> {
  return runCommand("git", ["-C", cwd, "-c", "user.email=publish@test", "-c", "user.name=Publish", ...args], `running git ${args[0]}`);
}

/** Real workspace: bare remote, pushed main, ticket branch with one commit ahead, optionally only an empty checkpoint commit. */
async function workspaceWithRemote(mode: "changed" | "empty-checkpoint" = "changed"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-publish-"));
  const remote = join(root, "remote.git");
  const workspace = join(root, "workspace");
  await runCommand("git", ["init", "--bare", remote], "creating bare remote");
  await runCommand("git", ["clone", remote, workspace], "cloning empty remote");
  await git(workspace, ["checkout", "-B", "main"]);
  await writeFile(join(workspace, "README.md"), "# App\n");
  await git(workspace, ["add", "README.md"]);
  await git(workspace, ["commit", "-m", "init"]);
  await git(workspace, ["push", "origin", "main"]);
  await git(workspace, ["checkout", "-b", BRANCH]);
  if (mode === "changed") {
    await writeFile(join(workspace, "login.ts"), "export const redirect = true;\n");
    await git(workspace, ["add", "login.ts"]);
    await git(workspace, ["commit", "-m", "fix login redirect"]);
  } else {
    await git(workspace, ["commit", "--allow-empty", "-m", "chore: stage checkpoint"]);
  }
  return workspace;
}

function contentAgent(body = "Verified with curl.", mutate?: () => Promise<void>): AgentRunner {
  return async <TOutput>(request: AgentRunRequest<TOutput>) => {
    if (mutate) {
      await mutate();
    }
    return { iterations: [], commits: [], stdout: "", branch: BRANCH, handoff: { title: "Fix login redirect", body } as TOutput };
  };
}

function providerStub(outcome: "ok" | "http-failure", support: "configured" | "unsupported" = "unsupported"): { provider: GitProvider; requests: DraftPullRequestRequest[] } {
  const requests: DraftPullRequestRequest[] = [];
  const provider: GitProvider = {
    name: "github",
    credential: "gh_secret_abc",
    mergeStrategySupport: support,
    validateRepository: () => undefined,
    createDraftPullRequest: async (request) => {
      requests.push(request);
      if (outcome === "http-failure") {
        throw new CommandFailedError(
          { operation: "creating draft pull request", command: "curl https://api.github.com/repos/acme/app/pulls", exitCode: 422, stdout: "", stderr: "Unprocessable Entity" },
          undefined,
        );
      }
      return { number: 7, url: "https://github.com/acme/app/pull/7", squashPreference: support } satisfies DraftPullRequest;
    },
    secrets: () => ["gh_secret_abc"],
  };
  return { provider, requests };
}

function input(workspacePath: string, runAgent: AgentRunner, gitProvider: GitProvider): PublishPullRequestInput {
  return { ticket, workspacePath, branch: BRANCH, attemptId: "1", harness: "pi", runAgent, gitProvider, onContentComplete: async () => {} };
}

test("publication pushes the branch and returns the final SHA, draft pull request, and squash preference", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("ok");
  const result = await publishPullRequest(input(workspace, contentAgent(), provider));
  const expectedSha = (await git(workspace, ["rev-parse", "HEAD"])).trim();
  assert.equal(result.finalSha, expectedSha);
  assert.equal(result.pullRequest.url, "https://github.com/acme/app/pull/7");
  assert.equal(result.squashPreference, "unsupported");
  assert.equal(requests[0]!.mergeStrategy, "squash");
  const remote = join(workspace, "..", "remote.git");
  const pushed = (await runCommand("git", ["-C", remote, "rev-parse", `refs/heads/${BRANCH}`], "reading pushed branch")).trim();
  assert.equal(pushed, expectedSha);
});

test("a branch whose commits change no files fails the change set before push and provider calls", async () => {
  const workspace = await workspaceWithRemote("empty-checkpoint");
  const { provider, requests } = providerStub("ok");

  await assert.rejects(publishPullRequest(input(workspace, contentAgent(), provider)), (error: unknown) => {
    assert.ok(error instanceof PublicationError);
    assert.equal(error.substage, "change set");
    return true;
  });
  assert.equal(requests.length, 0);
  const remote = join(workspace, "..", "remote.git");
  await assert.rejects(runCommand("git", ["-C", remote, "rev-parse", `refs/heads/${BRANCH}`], "reading pushed branch"));
});

test("an unsupported provider appends the runner's squash note inside the body limit", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("ok", "unsupported");

  await publishPullRequest(input(workspace, contentAgent("y".repeat(5000)), provider));

  const body = requests[0]!.body;
  assert.ok(body.length <= 5000, `the published body stays within the provider limit, got ${body.length}`);
  assert.match(body, /squash/);
  assert.match(body, /^y+/, "the agent prose is preserved at the start");
});

test("a configured provider publishes the agent body unchanged", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("ok", "configured");

  await publishPullRequest(input(workspace, contentAgent("Verified with curl."), provider));

  assert.equal(requests[0]!.body, "Verified with curl.");
});

test("content stage mutations reject publication before any provider call", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("ok");
  const runAgent = contentAgent("Verified with curl.", async () => writeFile(join(workspace, "scratch.md"), "uncommitted\n"));
  const error = await publishPullRequest(input(workspace, runAgent, provider)).catch((e) => e as PublicationError);
  assert.ok(error instanceof PublicationError);
  assert.equal(error.substage, "pull-request content");
  assert.match(String(error.cause), /worktree status/);
  assert.equal(requests.length, 0);
});

test("a missing content handoff fails before push or provider calls", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("ok");
  const missing: AgentRunner = async () => {
    throw new MissingAgentHandoffError();
  };

  const error = await publishPullRequest(input(workspace, missing, provider)).catch((value) => value as PublicationError);

  assert.ok(error instanceof PublicationError);
  assert.equal(error.substage, "pull-request content");
  assert.ok(error.cause instanceof MissingAgentHandoffError);
  assert.equal(requests.length, 0);
});

test("content containing provider credential material fails before push or provider calls", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("ok");

  const error = await publishPullRequest(input(workspace, contentAgent("Leaked gh_secret_abc"), provider)).catch((value) => value as PublicationError);

  assert.ok(error instanceof PublicationError);
  assert.equal(error.substage, "pull-request content");
  assert.match(String(error.cause), /credential material/);
  assert.equal(requests.length, 0);
  const remote = join(workspace, "..", "remote.git");
  await assert.rejects(runCommand("git", ["-C", remote, "rev-parse", `refs/heads/${BRANCH}`], "reading pushed branch"));
});

test("a branch with no commits ahead of the base branch cannot publish", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-publish-"));
  const remote = join(root, "remote.git");
  const workspace = join(root, "workspace");
  await runCommand("git", ["init", "--bare", remote], "creating bare remote");
  await runCommand("git", ["clone", remote, workspace], "cloning empty remote");
  await git(workspace, ["checkout", "-B", "main"]);
  await writeFile(join(workspace, "README.md"), "# App\n");
  await git(workspace, ["add", "README.md"]);
  await git(workspace, ["commit", "-m", "init"]);
  await git(workspace, ["push", "origin", "main"]);
  await git(workspace, ["checkout", "-b", BRANCH]);
  const { provider, requests } = providerStub("ok");
  const error = await publishPullRequest(input(workspace, contentAgent(), provider)).catch((e) => e as PublicationError);
  assert.ok(error instanceof PublicationError);
  assert.equal(error.substage, "commit count");
  assert.match(String(error.cause), /has no commits ahead of origin\/main/);
  assert.equal(requests.length, 0);
});

test("a failed push prevents pull request creation", async () => {
  const workspace = await workspaceWithRemote();
  await git(workspace, ["remote", "set-url", "origin", "/nonexistent/remote.git"]);
  const { provider, requests } = providerStub("ok");
  const error = await publishPullRequest(input(workspace, contentAgent(), provider)).catch((e) => e as PublicationError);
  assert.ok(error instanceof PublicationError);
  assert.equal(error.substage, "push");
  assert.equal(requests.length, 0);
});

test("provider failures keep the draft pull request substage and original diagnostics", async () => {
  const workspace = await workspaceWithRemote();
  const { provider, requests } = providerStub("http-failure");
  const error = await publishPullRequest(input(workspace, contentAgent(), provider)).catch((e) => e as PublicationError);
  assert.ok(error instanceof PublicationError);
  assert.equal(error.substage, "draft pull request");
  assert.equal(requests.length, 1);
  const cause = error.cause as CommandFailedError;
  assert.ok(cause instanceof CommandFailedError);
  assert.equal(cause.failure.exitCode, 422);
});

test("an initial repository snapshot failure keeps the content substage and Git diagnostics", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "sandcastle-publish-snapshot-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const { provider, requests } = providerStub("ok");
  let agentStarted = false;
  const runAgent = contentAgent("Verified with curl.", async () => { agentStarted = true; });
  await assert.rejects(publishPullRequest(input(workspace, runAgent, provider)), (error: unknown) => {
    assert.ok(error instanceof PublicationError);
    assert.equal(error.substage, "pull-request content");
    assert.ok(error.cause instanceof CommandFailedError);
    assert.equal(error.cause.failure.operation, "reading HEAD commit");
    assert.equal(error.cause.failure.exitCode, 128);
    assert.match(error.cause.failure.stderr, /not a git repository/);
    return true;
  });
  assert.equal(agentStarted, false);
  assert.deepEqual(requests, []);
});
