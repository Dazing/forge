import assert from "node:assert/strict";
import { test } from "node:test";
import { BacklogConfigurationError, BacklogConflictError, BacklogHttpError, createGitHubBacklog } from "./index.js";
import type { Fetch } from "../git-provider/git-provider.js";

const token = "ghp_backlog_secret_9f2c";
const env = { FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_URL: "https://github.com/orgs/acme/projects/7", FORGE_BACKLOG_TOKEN: token };

type Recorded = { url: string; method: string; headers: Record<string, string>; body?: unknown };

const resolvedProject = JSON.stringify({ data: { organization: { projectV2: { id: "PVT_kwH_private1" } } } });

/** Routing fetch seam: the test owns every response, so no request can reach the network. */
function routingFetch(respond: (url: string, init: RequestInit) => { status?: number; body: string }): { fetch: Fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      // Constructing the transport resolves the Project URL; that lookup is setup, never the operation under test.
      if (String(init.body ?? "").includes("ResolveProject")) return new Response(resolvedProject, { status: 200, statusText: "Status" });
      const method = init.method ?? "GET";
      calls.push({ url, method, headers: init.headers as Record<string, string>, ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) }) });
      const { status = 200, body } = respond(url, init);
      return new Response(body, { status, statusText: "Status" });
    },
  };
}

// The privacy gate reads the Project with a POST to /graphql, so a backlog mutation is any non-GET
// REST call: zero mutations means no issue, comment, or status write left the transport.
const writes = (calls: readonly Recorded[]): readonly Recorded[] => calls.filter((call) => call.method !== "GET" && !call.url.endsWith("/graphql"));

function issue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    node_id: `I_NODE_${number}`,
    html_url: `https://github.com/acme/backlog/issues/${number}`,
    title: `Ticket ${number}`,
    body: `# Ticket ${number}`,
    state: "open",
    updated_at: `2026-10-16T0${number % 10}:00:00Z`,
    user: { login: "author" },
    ...overrides,
  };
}

const privateRepo = JSON.stringify({ private: true, full_name: "acme/backlog" });
const privateProject = JSON.stringify({ data: { node: { id: "PVT_kwH_private1", number: 7, title: "Backlog", url: "https://github.com/orgs/acme/projects/7", public: false, viewerCanUpdate: true } } });

test("lists every issue across pages, excludes pull requests, and stops at the short page", async () => {
  const pages: Record<string, unknown[]> = {
    "page=1": Array.from({ length: 100 }, (_, index) => issue(index + 1)),
    "page=2": Array.from({ length: 100 }, (_, index) => issue(101 + index)),
    "page=3": [issue(201), issue(202, { pull_request: { url: "https://api.github.com/repos/acme/backlog/pulls/202" } })],
  };
  const seam = routingFetch((url) => ({ body: JSON.stringify(pages[url.includes("page=3") ? "page=3" : url.includes("page=2") ? "page=2" : "page=1"]) }));

  const issues = await (await createGitHubBacklog(env, seam.fetch)).listIssues();

  assert.equal(issues.length, 201);
  assert.deepEqual(issues.map((entry) => entry.number).slice(-2), [200, 201]);
  assert.equal(issues.some((entry) => entry.number === 202), false);
  // Three pages requested; the short page ends pagination.
  assert.equal(seam.calls.length, 3);
  assert.match(seam.calls[0]!.url, /\/repos\/acme\/backlog\/issues\?state=all&per_page=100&page=1$/);
  assert.deepEqual(issues[0], {
    number: 1,
    nodeId: "I_NODE_1",
    url: "https://github.com/acme/backlog/issues/1",
    title: "Ticket 1",
    body: "# Ticket 1",
    state: "open",
    stateReason: undefined,
    revision: "2026-10-16T01:00:00Z",
    author: "author",
  });
});

test("lists comments across pages and deduplicates repeated node ids", async () => {
  const comment = (id: number) => ({ id, node_id: `IC_${id}`, html_url: `https://github.com/acme/backlog/issues/9#issuecomment-${id}`, body: `evidence ${id}`, created_at: "2026-10-16T09:00:00Z", user: { login: "runner" } });
  const pages: Record<string, unknown[]> = {
    "page=1": Array.from({ length: 100 }, (_, index) => comment(index + 1)),
    // GitHub can repeat a newly inserted comment on the following page; node ids deduplicate it.
    "page=2": [comment(100), comment(101), comment(102)],
  };
  const seam = routingFetch((url) => ({ body: JSON.stringify(url.includes("page=2") ? pages["page=2"] : pages["page=1"]) }));

  const comments = await (await createGitHubBacklog(env, seam.fetch)).listComments(9);

  assert.equal(comments.length, 102);
  assert.equal(comments.filter((entry) => entry.nodeId === "IC_100").length, 1);
  assert.deepEqual(comments.slice(-2).map((entry) => entry.nodeId), ["IC_101", "IC_102"]);
  assert.deepEqual(comments[0], { id: 1, nodeId: "IC_1", url: "https://github.com/acme/backlog/issues/9#issuecomment-1", body: "evidence 1", author: "runner", createdAt: "2026-10-16T09:00:00Z" });
  assert.equal(seam.calls.length, 2);
});

test("a public repository blocks issue creation before any write request", async () => {
  const seam = routingFetch((url) => (url.endsWith("/repos/acme/backlog") ? { body: JSON.stringify({ private: false, full_name: "acme/backlog" }) } : { body: privateProject }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).createIssue("Ticket", "# Ticket"),
    (error: unknown) => error instanceof BacklogConfigurationError && /is public, so ticket content would be published/.test(error.message),
  );
  assert.deepEqual(writes(seam.calls), []);
});

test("a public Project blocks commenting even when the repository is private", async () => {
  const seam = routingFetch((url) => (url.includes("/graphql")
    ? { body: JSON.stringify({ data: { node: { id: "PVT_kwH_private1", number: 7, title: "Backlog", url: "https://github.com/orgs/acme/projects/7", public: true, viewerCanUpdate: true } } }) }
    : { body: privateRepo }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).createComment(4, "evidence"),
    (error: unknown) => error instanceof BacklogConfigurationError && /Project PVT_kwH_private1 is public/.test(error.message),
  );
  assert.deepEqual(writes(seam.calls), []);
});

test("creates a private issue with GitHub REST headers and payload", async () => {
  const seam = routingFetch((url) => {
    if (url.endsWith("/repos/acme/backlog")) return { body: privateRepo };
    if (url.includes("/graphql")) return { body: privateProject };
    return { status: 201, body: JSON.stringify(issue(12, { updated_at: "2026-10-16T10:00:00Z" })) };
  });

  const created = await (await createGitHubBacklog(env, seam.fetch)).createIssue("Fix login redirect", "# Fix login redirect");

  assert.deepEqual(created, { number: 12, nodeId: "I_NODE_12", url: "https://github.com/acme/backlog/issues/12" });
  const post = writes(seam.calls).find((call) => call.url.endsWith("/repos/acme/backlog/issues"))!;
  assert.deepEqual(post.body, { title: "Fix login redirect", body: "# Fix login redirect" });
  assert.equal(post.headers.Accept, "application/vnd.github+json");
  assert.equal(post.headers.Authorization, `Bearer ${token}`);
  assert.equal(post.headers["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(post.headers["User-Agent"], "sandcastle-runner");
  assert.equal(post.headers["Content-Type"], "application/json");
});

test("a revision change between read and write conflicts with no PATCH sent", async () => {
  const stored = issue(12, { updated_at: "2026-10-16T11:00:00Z" });
  const seam = routingFetch((url) => {
    if (url.endsWith("/repos/acme/backlog")) return { body: privateRepo };
    if (url.includes("/graphql")) return { body: privateProject };
    return { body: JSON.stringify(stored) };
  });

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).updateIssueBody(12, "# Intended body text", "2026-10-16T10:00:00Z"),
    (error: unknown) => error instanceof BacklogConflictError
      && /issue 12 changed externally/.test(error.message)
      && /expected revision 2026-10-16T10:00:00Z, found 2026-10-16T11:00:00Z/.test(error.message)
      && !error.message.includes("Intended body text"),
  );
  assert.equal(stored.body, "# Ticket 12");
  assert.deepEqual(writes(seam.calls), []);
});

test("a read-back showing a foreign body fails the update structurally", async () => {
  let stored = issue(12, { updated_at: "2026-10-16T10:00:00Z" });
  const seam = routingFetch((url, init) => {
    if (url.endsWith("/repos/acme/backlog")) return { body: privateRepo };
    if (url.includes("/graphql")) return { body: privateProject };
    if (init.method === "PATCH") stored = { ...stored, body: "written by someone else", updated_at: "2026-10-16T12:00:00Z" };
    return { body: JSON.stringify(stored) };
  });

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).updateIssueBody(12, "# Intended", "2026-10-16T10:00:00Z"),
    (error: unknown) => error instanceof BacklogHttpError
      && error.operation === "verifying backlog issue 12 update"
      && error.stderr === "Stored revision 2026-10-16T12:00:00Z does not carry the submitted body.",
  );
  assert.equal(writes(seam.calls).filter((call) => call.method === "PATCH").length, 1);
});

test("a successful update returns the re-read issue with its new revision", async () => {
  let stored = issue(12, { updated_at: "2026-10-16T10:00:00Z" });
  const seam = routingFetch((url, init) => {
    if (url.endsWith("/repos/acme/backlog")) return { body: privateRepo };
    if (url.includes("/graphql")) return { body: privateProject };
    if (init.method === "PATCH") stored = { ...stored, body: "# Intended", updated_at: "2026-10-16T12:00:00Z" };
    return { body: JSON.stringify(stored) };
  });

  const updated = await (await createGitHubBacklog(env, seam.fetch)).updateIssueBody(12, "# Intended", "2026-10-16T10:00:00Z");

  assert.equal(updated.body, "# Intended");
  assert.equal(updated.revision, "2026-10-16T12:00:00Z");
  assert.deepEqual(writes(seam.calls).find((call) => call.method === "PATCH")!.body, { body: "# Intended" });
});

test("closing an issue completed sends the completed state reason", async () => {
  const seam = routingFetch((url) => {
    if (url.endsWith("/repos/acme/backlog")) return { body: privateRepo };
    if (url.includes("/graphql")) return { body: privateProject };
    return { body: JSON.stringify(issue(12, { state: "closed", state_reason: "completed" })) };
  });

  await (await createGitHubBacklog(env, seam.fetch)).closeIssueCompleted(12);

  const patch = writes(seam.calls).find((call) => call.method === "PATCH")!;
  assert.equal(patch.url, "https://api.github.com/repos/acme/backlog/issues/12");
  assert.deepEqual(patch.body, { state: "closed", state_reason: "completed" });
});

test("an oversized comment is rejected before any request", async () => {
  const seam = routingFetch(() => ({ body: privateRepo }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).createComment(12, "x".repeat(65537)),
    (error: unknown) => error instanceof BacklogConfigurationError && /65537 characters and exceeds the GitHub limit of 65536/.test(error.message),
  );
  assert.deepEqual(seam.calls, []);
});

test("a missing issue reads as undefined", async () => {
  const seam = routingFetch(() => ({ status: 404, body: "{\"message\":\"Not Found\"}" }));

  assert.equal(await (await createGitHubBacklog(env, seam.fetch)).getIssue(99), undefined);
});

test("a 500 response body is redacted in the structured failure", async () => {
  const seam = routingFetch(() => ({ status: 500, body: `internal error, forwarded ${token} by the proxy` }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateRepository(),
    (error: unknown) => error instanceof BacklogHttpError
      && error.status === 500
      && error.stdout === "internal error, forwarded [redacted-token] by the proxy"
      && error.stderr === "HTTP 500"
      && !error.message.includes(token),
  );
});

test("a transport rejection becomes a structured failure with status zero", async () => {
  const failing: Fetch = async (_url, init) => {
    if (String(init.body ?? "").includes("ResolveProject")) return new Response(resolvedProject, { status: 200, statusText: "Status" });
    throw new Error(`connect ECONNREFUSED with ${token}`);
  };

  await assert.rejects(
    (await createGitHubBacklog(env, failing)).listIssues(),
    (error: unknown) => error instanceof BacklogHttpError
      && error.status === 0
      && error.stderr === "connect ECONNREFUSED with [redacted-token]"
      && !error.message.includes(token),
  );
});

for (const status of [401, 403]) {
  test(`HTTP ${status} names the operation and endpoint as a configuration failure`, async () => {
    const seam = routingFetch(() => ({ status, body: "Bad credentials" }));

    await assert.rejects(
      (await createGitHubBacklog(env, seam.fetch)).listIssues(),
      (error: unknown) => error instanceof BacklogConfigurationError
        && /listing backlog issues/.test(error.message)
        && /https:\/\/api\.github\.com\/repos\/acme\/backlog\/issues/.test(error.message),
    );
  });
}

test("a missing or invisible repository is a configuration failure", async () => {
  const seam = routingFetch(() => ({ status: 404, body: "{\"message\":\"Not Found\"}" }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateRepository(),
    (error: unknown) => error instanceof BacklogConfigurationError && /does not exist or the backlog token cannot see it/.test(error.message),
  );
});

test("configuration names each missing variable and never echoes the token", async () => {
  const unused: Fetch = () => Promise.reject(new Error("no request is allowed before configuration is valid"));
  const projectUrl = "https://github.com/orgs/acme/projects/7";

  await assert.rejects(
    createGitHubBacklog({ FORGE_BACKLOG_PROJECT_URL: projectUrl, FORGE_BACKLOG_TOKEN: token }, unused),
    (error: unknown) => error instanceof BacklogConfigurationError && /FORGE_BACKLOG_REPOSITORY/.test(error.message),
  );
  await assert.rejects(
    createGitHubBacklog({ FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_URL: projectUrl, FORGE_BACKLOG_TOKEN: "   " }, unused),
    (error: unknown) => error instanceof BacklogConfigurationError && /FORGE_BACKLOG_TOKEN/.test(error.message),
  );
  await assert.rejects(
    createGitHubBacklog({ FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_TOKEN: token }, unused),
    (error: unknown) => error instanceof BacklogConfigurationError && /FORGE_BACKLOG_PROJECT_URL/.test(error.message),
  );
  await assert.rejects(
    createGitHubBacklog({ FORGE_BACKLOG_REPOSITORY: "https://github.com/acme/backlog", FORGE_BACKLOG_PROJECT_URL: projectUrl, FORGE_BACKLOG_TOKEN: token }, unused),
    (error: unknown) => error instanceof BacklogConfigurationError && /must be `owner\/repository`; got https:\/\/github\.com\/acme\/backlog/.test(error.message),
  );
  for (const incomplete of [
    { FORGE_BACKLOG_PROJECT_URL: projectUrl, FORGE_BACKLOG_TOKEN: token },
    { FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_TOKEN: "   " },
  ]) {
    await assert.rejects(
      createGitHubBacklog(incomplete, unused),
      (error: unknown) => !(error as Error).message.includes(token),
    );
  }
});

test("the transport reports its repository, Project, and secrets for aggregate redaction", async () => {
  const seam = routingFetch(() => ({ body: privateRepo }));

  const backlog = await createGitHubBacklog(env, seam.fetch);

  assert.equal(backlog.repository, "acme/backlog");
  assert.equal(backlog.projectId, "PVT_kwH_private1");
  assert.deepEqual(backlog.secrets, [token]);
});
