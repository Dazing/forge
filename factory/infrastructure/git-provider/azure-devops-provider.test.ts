import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandFailedError, toCommandFailure } from "./git.js";
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
  mergeStrategy: "squash" as const,
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
  const seam = recordingFetch(201, "Created", JSON.stringify({ pullRequestId: 22, isDraft: true, completionOptions: { mergeStrategy: "squash" } }));

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
    completionOptions: { mergeStrategy: "squash", isDraft: true, deleteSourceBranch: false, bypassPolicy: false },
  });
});

test("returns the browser-facing PR page and the persisted squash preference", async () => {
  const seam = recordingFetch(
    201,
    "Created",
    JSON.stringify({ pullRequestId: 22, isDraft: true, completionOptions: { mergeStrategy: "squash" }, url: "https://dev.azure.com/Contoso%20Team/_apis/git/repositories/fix-login/pullRequests/22" }),
  );

  const result = await new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request);

  assert.deepEqual(result, { number: 22, url: "https://dev.azure.com/Contoso%20Team/Web%20App/_git/fix-login/pullrequest/22", squashPreference: "configured" });
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

test("the create response without completion options is verified by one read-back request", async () => {
  const bodies = [
    JSON.stringify({ pullRequestId: 22, isDraft: true }),
    JSON.stringify({ pullRequestId: 22, isDraft: true, completionOptions: { mergeStrategy: "squash" } }),
  ];
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(bodies[calls.length - 1]!, { status: 201, statusText: "Created" });
  };

  const result = await new AzureDevOpsProvider(pat, fetch).createDraftPullRequest(request);

  assert.equal(result.squashPreference, "configured");
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.init.method, "GET");
  assert.equal(calls[1]!.url, "https://dev.azure.com/Contoso%20Team/Web%20App/_apis/git/repositories/fix-login/pullrequests/22?api-version=7.1");
});

test("a persisted merge strategy other than squash fails the draft publication and records the created PR URL", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ pullRequestId: 22, isDraft: true, completionOptions: { mergeStrategy: "no-fast-forward" } }));

  await assert.rejects(new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    const diagnostic = toCommandFailure(error, "draft pull request");
    assert.match(diagnostic.stderr, /no-fast-forward.*squash/);
    assert.match(diagnostic.stderr, /https:\/\/dev\.azure\.com\/Contoso%20Team\/Web%20App\/_git\/fix-login\/pullrequest\/22/);
    return true;
  });
  assert.equal(seam.calls.length, 1);
});

test("a response that is not a draft fails the draft publication", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ pullRequestId: 22, isDraft: false, completionOptions: { mergeStrategy: "squash" } }));

  await assert.rejects(new AzureDevOpsProvider(pat, seam.fetch).createDraftPullRequest(request), /draft/);
});

test("secrets reports the raw PAT and the derived Basic value", () => {
  assert.deepEqual(new AzureDevOpsProvider(pat).secrets(), [pat, basicAuth]);
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

test("read-back rejects a non-draft pull request even when squash is persisted", async () => {
  let calls = 0;
  const fetch: Fetch = async () => new Response(JSON.stringify(++calls === 1
    ? { pullRequestId: 22, isDraft: true }
    : { pullRequestId: 22, isDraft: false, completionOptions: { mergeStrategy: "squash" } }), { status: calls === 1 ? 201 : 200 });

  await assert.rejects(new AzureDevOpsProvider(pat, fetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.match(error.failure.command, /^GET /);
    assert.match(error.failure.stderr, /non-draft/);
    assert.match(error.failure.stderr, /pullrequest\/22/);
    return true;
  });
  assert.equal(calls, 2);
});

test("read-back rejects an HTTP error even when its body describes a draft with squash", async () => {
  let calls = 0;
  const fetch: Fetch = async () => {
    calls++;
    return new Response(JSON.stringify(calls === 1
      ? { pullRequestId: 22, isDraft: true }
      : { pullRequestId: 22, isDraft: true, completionOptions: { mergeStrategy: "squash" }, diagnostic: `${pat} ${basicAuth}` }),
    { status: calls === 1 ? 201 : 503, statusText: calls === 1 ? "Created" : "Service Unavailable" });
  };

  await assert.rejects(new AzureDevOpsProvider(pat, fetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.equal(error.failure.exitCode, 503);
    assert.match(error.failure.command, /^GET /);
    assert.match(error.failure.stderr, /HTTP 503/);
    assert.match(error.failure.stderr, /pullrequest\/22/);
    assert.ok(!JSON.stringify(error.failure).includes(pat));
    assert.ok(!JSON.stringify(error.failure).includes(basicAuth));
    return true;
  });
  assert.equal(calls, 2);
});

test("read-back rejects a different pull-request identity", async () => {
  let calls = 0;
  const fetch: Fetch = async () => new Response(JSON.stringify(++calls === 1
    ? { pullRequestId: 22, isDraft: true }
    : { pullRequestId: 23, isDraft: true, completionOptions: { mergeStrategy: "squash" } }), { status: calls === 1 ? 201 : 200 });

  await assert.rejects(new AzureDevOpsProvider(pat, fetch).createDraftPullRequest(request), (error: unknown) => {
    assert.ok(error instanceof CommandFailedError);
    assert.match(error.failure.stderr, /23.*22/);
    assert.match(error.failure.stderr, /pullrequest\/22/);
    return true;
  });
  assert.equal(calls, 2);
});

for (const scenario of [
  { name: "missing preference", response: JSON.stringify({ pullRequestId: 22, isDraft: true }), reason: /merge strategy none.*squash/ },
  { name: "malformed response", response: `invalid JSON ${pat} ${basicAuth}`, reason: /read-back response is invalid/ },
  { name: "transport failure", response: undefined, reason: /connection lost/ },
]) {
  test(`read-back ${scenario.name} retains the created URL in credential-safe settlement diagnostics`, async () => {
    let calls = 0;
    const fetch: Fetch = async () => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ pullRequestId: 22, isDraft: true }), { status: 201 });
      if (scenario.response === undefined) throw new Error(`connection lost ${pat} ${basicAuth}`);
      return new Response(scenario.response, { status: 200 });
    };

    await assert.rejects(new AzureDevOpsProvider(pat, fetch).createDraftPullRequest(request), (error: unknown) => {
      assert.ok(error instanceof CommandFailedError);
      const diagnostic = toCommandFailure(error, "draft pull request");
      assert.match(diagnostic.command, /^GET /);
      assert.match(diagnostic.stderr, scenario.reason);
      assert.match(diagnostic.stderr, /https:\/\/dev\.azure\.com\/Contoso%20Team\/Web%20App\/_git\/fix-login\/pullrequest\/22/);
      assert.ok(!JSON.stringify(diagnostic).includes(pat));
      assert.ok(!JSON.stringify(diagnostic).includes(basicAuth));
      return true;
    });
    assert.equal(calls, 2);
  });
}

test("reads and safely updates the exact unchanged Azure draft with squash preserved", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const details = {
    pullRequestId: 22,
    status: "active",
    isDraft: true,
    sourceRefName: `refs/heads/${request.head}`,
    targetRefName: `refs/heads/${request.base}`,
    title: request.title,
    description: request.body,
    lastMergeSourceCommit: { commitId: "a".repeat(40) },
    completionOptions: { mergeStrategy: "squash" },
  };
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return init.method === "PATCH"
      ? new Response(JSON.stringify({ pullRequestId: 22, isDraft: true, completionOptions: { mergeStrategy: "squash" } }), { status: 200 })
      : new Response(JSON.stringify(details), { status: 200 });
  };
  const provider = new AzureDevOpsProvider(pat, fetch);
  assert.equal((await provider.getPullRequest(request.repositoryUrl, 22))?.sourceSha, "a".repeat(40));
  await provider.updateDraftPullRequest({ ...request, number: 22, expectedSourceSha: "a".repeat(40), expectedTitle: request.title, expectedBody: request.body, title: "Updated", body: "Updated body" });
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "PATCH"]);
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), {
    title: "Updated",
    description: "Updated body",
    isDraft: true,
    completionOptions: { mergeStrategy: "squash", deleteSourceBranch: false, bypassPolicy: false },
  });
});

function pullRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pullRequestId: 42,
    status: "active",
    isDraft: true,
    sourceRefName: `refs/heads/${request.head}`,
    targetRefName: `refs/heads/${request.base}`,
    title: request.title,
    description: request.body,
    creationDate: "2026-10-11T08:00:00Z",
    lastMergeSourceCommit: { commitId: "a".repeat(40) },
    ...overrides,
  };
}

test("findPullRequest matches the exact open draft via api-version 7.1 with encoded segments and status=all", async () => {
  const seam = recordingFetch(200, "OK", JSON.stringify({ value: [pullRecord()] }));
  const found = await new AzureDevOpsProvider(pat, seam.fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base, sourceSha: "a".repeat(40) });
  assert.deepEqual(found, {
    provider: "azure-devops",
    repository: request.repositoryUrl,
    number: 42,
    url: "https://dev.azure.com/Contoso%20Team/Web%20App/_git/fix-login/pullrequest/42",
    baseBranch: "release/2.1",
    headBranch: request.head,
    sourceSha: "a".repeat(40),
    title: request.title,
    body: request.body,
    draft: true,
    state: "open",
    mergeMethod: "unknown",
    mergeCommitSha: undefined,
  });
  assert.equal(new URL(seam.calls[0]!.url).searchParams.get("searchCriteria.status"), "all");
  assert.equal(new URL(seam.calls[0]!.url).pathname, "/Contoso%20Team/Web%20App/_apis/git/repositories/fix-login/pullrequests");
  assert.equal(new URL(seam.calls[0]!.url).searchParams.get("api-version"), "7.1");
  assert.deepEqual((seam.calls[0]!.init.headers as Record<string, string>).Authorization, `Basic ${basicAuth}`);
});

test("the same findPullRequest lookup discovers merged and closed pull requests with their merge facts", async () => {
  const merged = await new AzureDevOpsProvider(pat, recordingFetch(200, "OK", JSON.stringify({ value: [pullRecord({ status: "completed", lastMergeCommit: { commitId: "b".repeat(40) }, completionOptions: { mergeStrategy: "squash" } })] })).fetch)
    .findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(merged?.state, "merged");
  assert.equal(merged?.mergeCommitSha, "b".repeat(40));
  assert.equal(merged?.mergeMethod, "squash");
  const closed = await new AzureDevOpsProvider(pat, recordingFetch(200, "OK", JSON.stringify({ value: [pullRecord({ status: "abandoned" })] })).fetch)
    .findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(closed?.state, "closed");
  assert.equal(closed?.mergeCommitSha, undefined);
});

test("findPullRequest refuses a pull request whose source commit differs from the required source SHA", async () => {
  const seam = recordingFetch(200, "OK", JSON.stringify({ value: [pullRecord({ lastMergeSourceCommit: { commitId: "c".repeat(40) } })] }));
  const found = await new AzureDevOpsProvider(pat, seam.fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base, sourceSha: "a".repeat(40) });
  assert.equal(found, undefined);
});

test("an empty pull-request list and a missing repository resolve to no pull request", async () => {
  const empty = await new AzureDevOpsProvider(pat, recordingFetch(200, "OK", '{"value":[]}').fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(empty, undefined);
  const missing = await new AzureDevOpsProvider(pat, recordingFetch(404, "Not Found", '{}').fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(missing, undefined);
});

test("a findPullRequest HTTP failure is a structured failure with both credential forms redacted", async () => {
  await assert.rejects(
    new AzureDevOpsProvider(pat, recordingFetch(502, "Bad Gateway", `upstream rejected ${pat} via Basic ${basicAuth}`).fetch)
      .findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base }),
    (error: unknown) => error instanceof CommandFailedError
      && error.failure.exitCode === 502
      && !JSON.stringify(error.failure).includes(pat)
      && !JSON.stringify(error.failure).includes(basicAuth),
  );
});
