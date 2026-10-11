import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandFailedError } from "./git.js";
import { GitHubProvider } from "./github-provider.js";
import type { Fetch } from "./git-provider.js";

const provider = new GitHubProvider("gh_secret_abc");

const request = {
  repositoryUrl: "git@github.com:acme/app.git",
  head: "agent-tickets/fix-login-1a2b3c",
  base: "main",
  title: "Fix login redirect",
  body: "Handles the expired session case.",
};

function recordingFetch(status: number, statusText: string, body: string): { fetch: Fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(body, { status, statusText });
    },
  };
}

test("accepts the canonical GitHub SSH URL", () => {
  provider.validateRepository("git@github.com:acme/app.git");
});

for (const repository of [
  "https://github.com/acme/app.git",
  "git@github.acme.com:acme/app.git",
  "/srv/repos/app.git",
  "ssh://git@github.com/acme/app.git",
  "git@github.com:acme/app",
  "git@ssh.dev.azure.com:v3/acme/app/app",
]) {
  test(`rejects non-github.com SSH repository ${repository}`, () => {
    assert.throws(() => provider.validateRepository(repository), /git@github\.com:<owner>\/<repository>\.git/);
  });
}

test("creates a draft pull request with GitHub REST headers and payload", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ number: 7, html_url: "https://github.com/acme/app/pull/7" }));

  const result = await new GitHubProvider("gh_secret_abc", seam.fetch).createDraftPullRequest(request);

  assert.deepEqual(result, { number: 7, url: "https://github.com/acme/app/pull/7" });
  assert.equal(seam.calls.length, 1);
  const { url, init } = seam.calls[0]!;
  assert.equal(url, "https://api.github.com/repos/acme/app/pulls");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Accept, "application/vnd.github+json");
  assert.equal(headers.Authorization, "Bearer gh_secret_abc");
  assert.equal(headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.match(headers["User-Agent"] ?? "", /sandcastle/);
  assert.deepEqual(JSON.parse(init.body as string), {
    title: "Fix login redirect",
    head: "agent-tickets/fix-login-1a2b3c",
    base: "main",
    body: "Handles the expired session case.",
    draft: true,
  });
});

test("non-2xx responses become structured failures with the HTTP status as exit code", async () => {
  const seam = recordingFetch(422, "Unprocessable Entity", "gh_secret_abc: Validation failed: head branch is not in the repository");

  await assert.rejects(new GitHubProvider("gh_secret_abc", seam.fetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.equal(error.failure.exitCode, 422);
    assert.equal(error.failure.operation, "creating draft pull request");
    assert.equal(error.failure.command, "POST https://api.github.com/repos/acme/app/pulls");
    assert.match(error.failure.stdout, /Validation failed/);
    assert.match(error.failure.stderr, /HTTP 422/);
    assert.ok(!error.failure.command.includes("gh_secret_abc"), "the token never reaches the displayed command");
    assert.ok(!error.failure.stdout.includes("gh_secret_abc"), "the token is redacted from response evidence");
    return true;
  });
});

test("responses without a valid number and html_url are rejected", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ number: 7 }));
  await assert.rejects(new GitHubProvider("gh_secret_abc", seam.fetch).createDraftPullRequest(request), /html_url/);
});

test("transport failures become structured failures with transport diagnostics", async () => {
  const failingFetch: Fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };
  await assert.rejects(new GitHubProvider("gh_secret_abc", failingFetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.equal(error.failure.exitCode, 1);
    assert.match(error.failure.stderr, /ENOTFOUND/);
    return true;
  });
});
