import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandFailedError } from "./git.js";
import { AzureDevOpsProvider } from "./azure-devops-provider.js";
import type { Fetch } from "./git-provider.js";

const pat = "vso_pat_secret_123";
// Documented PAT Basic form: base64(":" + PAT), computed independently of the implementation.
const basicAuth = "OnZzb19wYXRfc2VjcmV0XzEyMw==";

const request = {
  repositoryUrl: "git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login",
  head: "agent-tickets/fix-login-1a2b3c",
  base: "release/2.1",
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

test("accepts the canonical Azure DevOps SSH URL", () => {
  new AzureDevOpsProvider(pat).validateRepository("git@ssh.dev.azure.com:v3/Contoso Team/Web App/fix-login");
});

for (const repository of [
  "https://dev.azure.com/contoso/web/_git/fix-login",
  "git@ssh.visualstudio.com:v3/contoso/web/fix-login",
  "ssh://git@ssh.dev.azure.com/v3/contoso/web/fix-login",
  "git@ssh.dev.azure.com:v3/contoso/web",
  "git@ssh.dev.azure.com:v3//web/fix-login",
  "git@ssh.dev.azure.com:v3/contoso//fix-login",
  "git@ssh.dev.azure.com:v3/contoso/web/",
  "git@github.com:contoso/fix-login.git",
]) {
  test(`rejects non-Azure SSH repository ${repository}`, () => {
    assert.throws(() => new AzureDevOpsProvider(pat).validateRepository(repository), /git@ssh\.dev\.azure\.com:v3/);
  });
}

test("creates a draft pull request with encoded path segments, Basic auth, and fully qualified refs", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ pullRequestId: 22 }));

  const result = await new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request);

  assert.equal(seam.calls.length, 1);
  const { url, init } = seam.calls[0]!;
  assert.equal(url, "https://dev.azure.com/Contoso%20Team/Web%20App/_apis/git/repositories/fix-login/pullrequests?api-version=7.1");
  assert.equal(init.method, "POST");
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Basic ${basicAuth}`);
  assert.equal(headers["Content-Type"], "application/json");
  assert.match(headers["User-Agent"] ?? "", /sandcastle/);
  assert.deepEqual(JSON.parse(init.body as string), {
    sourceRefName: "refs/heads/agent-tickets/fix-login-1a2b3c",
    targetRefName: "refs/heads/release/2.1",
    title: "Fix login redirect",
    description: "Handles the expired session case.",
    isDraft: true,
  });
});

test("returns the browser-facing PR page, not the REST resource URL from the response", async () => {
  const seam = recordingFetch(
    201,
    "Created",
    JSON.stringify({ pullRequestId: 22, url: "https://dev.azure.com/Contoso%20Team/_apis/git/repositories/fix-login/pullRequests/22" }),
  );

  const result = await new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request);

  assert.deepEqual(result, { number: 22, url: "https://dev.azure.com/Contoso%20Team/Web%20App/_git/fix-login/pullrequest/22" });
});

test("non-2xx responses become structured failures with the HTTP status as exit code", async () => {
  const seam = recordingFetch(401, "Unauthorized", `TF400813: token ${pat} denied; header Basic ${basicAuth}`);

  await assert.rejects(new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.equal(error.failure.exitCode, 401);
    assert.equal(error.failure.operation, "creating draft pull request");
    assert.equal(error.failure.command, "POST https://dev.azure.com/Contoso%20Team/Web%20App/_apis/git/repositories/fix-login/pullrequests?api-version=7.1");
    assert.match(error.failure.stdout, /TF400813/);
    assert.match(error.failure.stderr, /HTTP 401/);
    assert.ok(!error.failure.command.includes(pat), "the PAT never reaches the displayed command");
    assert.ok(!error.failure.stdout.includes(pat), "the raw PAT is redacted from response evidence");
    assert.ok(!error.failure.stdout.includes(basicAuth), "the encoded Basic value is redacted from response evidence");
    return true;
  });
});

test("responses without a valid integer pullRequestId are rejected", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ pullRequestId: "22" }));
  await assert.rejects(new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request), /pullRequestId/);
});

test("transport failures become structured failures with redacted diagnostics", async () => {
  const failingFetch: Fetch = async () => {
    throw new Error(`getaddrinfo ENOTFOUND dev.azure.com while authenticating ${pat} as Basic ${basicAuth}`);
  };
  await assert.rejects(new AzureDevOpsProvider(pat, failingFetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.equal(error.failure.exitCode, 1);
    assert.match(error.failure.stderr, /ENOTFOUND/);
    assert.ok(!error.failure.stderr.includes(pat), "the raw PAT is redacted from transport diagnostics");
    assert.ok(!error.failure.stderr.includes(basicAuth), "the encoded Basic value is redacted from transport diagnostics");
    return true;
  });
});
