import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandFailedError } from "../shared/git.js";
import { createDraftPullRequest, type Fetch } from "./pull-request-service.js";

const request = {
  token: "gh_secret_abc",
  owner: "acme",
  repository: "app",
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

test("creates a draft pull request with GitHub REST headers and payload", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ number: 7, html_url: "https://github.com/acme/app/pull/7" }));

  const result = await createDraftPullRequest(request, seam.fetch);

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

  await assert.rejects(createDraftPullRequest(request, seam.fetch), (error: unknown) => {
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
  await assert.rejects(createDraftPullRequest(request, seam.fetch), /html_url/);
});

test("transport failures become structured failures with transport diagnostics", async () => {
  const failingFetch: Fetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  };
  await assert.rejects(createDraftPullRequest(request, failingFetch), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.equal(error.failure.exitCode, 1);
    assert.match(error.failure.stderr, /ENOTFOUND/);
    return true;
  });
});
