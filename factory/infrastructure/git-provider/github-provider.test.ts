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

  assert.deepEqual(result, { number: 7, url: "https://github.com/acme/app/pull/7", squashPreference: "unsupported" });
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

test("GitHub reports that a per-pull-request merge method is unsupported", () => {
  assert.equal(new GitHubProvider("gh_secret_abc").mergeStrategySupport, "unsupported");
});

test("the GitHub payload never carries a merge-method field that the REST API ignores", async () => {
  const seam = recordingFetch(201, "Created", JSON.stringify({ number: 7, html_url: "https://github.com/acme/app/pull/7" }));

  await new GitHubProvider("gh_secret_abc", seam.fetch).createDraftPullRequest(request);

  const body = JSON.parse(seam.calls[0]!.init.body as string);
  assert.deepEqual(Object.keys(body).sort(), ["base", "body", "draft", "head", "title"]);
});

test("secrets reports the GitHub token", () => {
  assert.deepEqual(new GitHubProvider("gh_secret_abc").secrets(), ["gh_secret_abc"]);
});

test("reads and safely updates the exact unchanged open draft pull request", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const details = {
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    state: "open",
    draft: true,
    merged_at: null,
    merge_commit_sha: null,
    title: request.title,
    body: request.body,
    head: { ref: request.head, sha: "a".repeat(40) },
    base: { ref: request.base },
  };
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    return init.method === "PATCH"
      ? new Response(JSON.stringify({ number: 7, html_url: details.html_url }), { status: 200 })
      : new Response(JSON.stringify(details), { status: 200 });
  };
  const configured = new GitHubProvider("gh_secret_abc", fetch);
  const read = await configured.getPullRequest(request.repositoryUrl, 7);
  assert.equal(read?.sourceSha, "a".repeat(40));
  await configured.updateDraftPullRequest({ ...request, number: 7, expectedSourceSha: "a".repeat(40), expectedTitle: request.title, expectedBody: request.body, title: "Updated", body: "Updated body" });
  assert.deepEqual(calls.map((call) => call.init.method), ["GET", "GET", "PATCH"]);
  assert.deepEqual(JSON.parse(calls[2]!.init.body as string), { title: "Updated", body: "Updated body", base: "main" });
});

function pullItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    html_url: "https://github.com/acme/app/pull/7",
    state: "open",
    draft: true,
    merged_at: null,
    merge_commit_sha: null,
    title: request.title,
    body: request.body,
    created_at: "2026-10-11T08:00:00Z",
    head: { ref: request.head, sha: "a".repeat(40) },
    base: { ref: request.base },
    ...overrides,
  };
}

test("findPullRequest matches the exact open draft and queries the pulls list with state=all", async () => {
  const seam = recordingFetch(200, "OK", JSON.stringify([pullItem()]));
  const found = await new GitHubProvider("gh_secret_abc", seam.fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base, sourceSha: "a".repeat(40) });
  assert.deepEqual(found, {
    provider: "github",
    repository: request.repositoryUrl,
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    baseBranch: "main",
    headBranch: request.head,
    sourceSha: "a".repeat(40),
    title: request.title,
    body: request.body,
    draft: true,
    state: "open",
    mergeMethod: "unknown",
    mergeCommitSha: undefined,
  });
  const url = new URL(seam.calls[0]!.url);
  assert.equal(url.pathname, "/repos/acme/app/pulls");
  assert.equal(url.searchParams.get("state"), "all", "closed and merged pull requests must stay discoverable after restart");
  assert.equal(url.searchParams.get("base"), "main");
  assert.equal(url.searchParams.get("head"), `acme:${request.head}`);
  assert.equal(url.searchParams.get("per_page"), "100");
});

test("the same findPullRequest lookup discovers merged and closed pull requests, reporting the merge commit only when merged", async () => {
  const merged = await new GitHubProvider("gh_secret_abc", recordingFetch(200, "OK", JSON.stringify([pullItem({ state: "closed", merged_at: "2026-10-12T08:00:00Z", merge_commit_sha: "b".repeat(40) })])).fetch)
    .findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(merged?.state, "merged");
  assert.equal(merged?.mergeCommitSha, "b".repeat(40));
  const closed = await new GitHubProvider("gh_secret_abc", recordingFetch(200, "OK", JSON.stringify([pullItem({ state: "closed" })])).fetch)
    .findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(closed?.state, "closed");
  assert.equal(closed?.mergeCommitSha, undefined);
});

test("findPullRequest refuses a pull request whose head SHA differs from the required source SHA", async () => {
  const seam = recordingFetch(200, "OK", JSON.stringify([pullItem({ head: { ref: request.head, sha: "c".repeat(40) } })]));
  const found = await new GitHubProvider("gh_secret_abc", seam.fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base, sourceSha: "a".repeat(40) });
  assert.equal(found, undefined);
});

test("an empty pulls list and a missing repository resolve to no pull request", async () => {
  const empty = await new GitHubProvider("gh_secret_abc", recordingFetch(200, "OK", "[]").fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(empty, undefined);
  const missing = await new GitHubProvider("gh_secret_abc", recordingFetch(404, "Not Found", '{"message":"Not Found"}').fetch).findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base });
  assert.equal(missing, undefined);
});

test("a findPullRequest HTTP failure is a structured failure with credentials redacted", async () => {
  const providerWithFetch = new GitHubProvider("gh_secret_abc", recordingFetch(502, "Bad Gateway", "upstream rejected gh_secret_abc").fetch);
  await assert.rejects(
    providerWithFetch.findPullRequest({ repository: request.repositoryUrl, head: request.head, base: request.base }),
    (error: unknown) => error instanceof CommandFailedError
      && error.failure.exitCode === 502
      && error.failure.stdout.includes("[redacted-token]")
      && !error.failure.stdout.includes("gh_secret_abc")
      && !JSON.stringify(error.failure).includes("gh_secret_abc"),
  );
});
