import assert from "node:assert/strict";
import { test } from "node:test";
import { BacklogConfigurationError, BacklogHttpError, createGitHubBacklog } from "./index.js";
import type { Fetch } from "../git-provider/git-provider.js";

// Project URL to node id: the pasted browser link is interpreted locally, resolved once through the
// fixed GraphQL endpoint, and only the resulting node id ever reaches board operations.

const token = "ghp_backlog_secret_9f2c";
const nodeId = "PVT_kwH_private1";
const STATUS_NAMES = ["Backlog", "Ready", "In progress", "In review", "Done", "Blocked"];
const optionId = (name: string): string => `OPT_${name.toUpperCase().replace(/ /g, "_")}`;
const env = { FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_URL: "https://github.com/orgs/acme/projects/7", FORGE_BACKLOG_TOKEN: token };

type Recorded = { url: string; method: string; headers: Record<string, string>; operation: string; query: string; variables: Record<string, unknown> };

/** GraphQL fetch seam: responses are selected by operation name, so a test scripts resolution and the board read separately. */
function graphqlFetch(respond: (operation: string, variables: Record<string, unknown>) => { status?: number; body: string }): { fetch: Fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const payload = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      const operation = /(?:query|mutation)\s+(\w+)/.exec(payload.query)?.[1] ?? "anonymous";
      calls.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, operation, query: payload.query, variables: payload.variables });
      const { status = 200, body } = respond(operation, payload.variables);
      return new Response(body, { status, statusText: "Status" });
    },
  };
}

const resolved = (owner: "organization" | "user", id: string): string => JSON.stringify({ data: { [owner]: { projectV2: { id } } } });

const statusFieldResponse = JSON.stringify({
  data: {
    node: {
      id: nodeId,
      number: 7,
      title: "Backlog",
      url: "https://github.com/orgs/acme/projects/7",
      public: false,
      viewerCanUpdate: true,
      fields: { nodes: [{ __typename: "ProjectV2SingleSelectField", id: "PVTSSF_field", name: "Status", options: STATUS_NAMES.map((name) => ({ id: optionId(name), name })) }] },
    },
  },
});

test("an organization Project URL resolves its node id once and every board read uses that id", async () => {
  const seam = graphqlFetch((operation) => ({ body: operation === "ResolveProject" ? resolved("organization", nodeId) : statusFieldResponse }));

  const backlog = await createGitHubBacklog(env, seam.fetch);

  assert.equal(backlog.projectId, nodeId);
  assert.deepEqual(backlog.secrets, [token]);
  assert.equal(seam.calls.length, 1, "the reference is resolved by exactly one request per constructed backlog");
  assert.equal(seam.calls[0]!.url, "https://api.github.com/graphql", "the supplied browser URL is never fetched");
  assert.equal(seam.calls[0]!.operation, "ResolveProject");
  assert.deepEqual(seam.calls[0]!.variables, { login: "acme", number: 7 });
  assert.match(seam.calls[0]!.headers.Authorization ?? "", /^Bearer ghp_backlog_secret_9f2c$/u);

  const field = await backlog.validateProject(STATUS_NAMES);

  assert.equal(field.fieldId, "PVTSSF_field");
  assert.equal(seam.calls[1]!.operation, "ProjectNode");
  assert.deepEqual(seam.calls[1]!.variables, { id: nodeId }, "board reads use the resolved node id, not the URL, owner, or number");
});

test("a board view URL with a trailing slash resolves the same Project identity", async () => {
  const seam = graphqlFetch(() => ({ body: resolved("organization", nodeId) }));

  const backlog = await createGitHubBacklog({ ...env, FORGE_BACKLOG_PROJECT_URL: "  https://github.com/orgs/acme/projects/7/views/3/  " }, seam.fetch);

  assert.equal(backlog.projectId, nodeId);
  assert.deepEqual(seam.calls[0]!.variables, { login: "acme", number: 7 }, "the view segment identifies browser filtering, not board identity");
});

test("a personal Project URL resolves through the user query and ignores query strings and fragments", async () => {
  const seam = graphqlFetch(() => ({ body: resolved("user", nodeId) }));

  const backlog = await createGitHubBacklog({ ...env, FORGE_BACKLOG_PROJECT_URL: "https://github.com/users/octocat/projects/12?test=1#view-2" }, seam.fetch);

  assert.equal(backlog.projectId, nodeId);
  assert.match(seam.calls[0]!.query, /user\(login: /u);
  assert.equal(seam.calls[0]!.query.includes("organization("), false);
  assert.deepEqual(seam.calls[0]!.variables, { login: "octocat", number: 12 });
});

test("a missing Project URL names the setting and never contacts GitHub, even when the legacy node id is configured", async () => {
  const seam = graphqlFetch(() => ({ body: resolved("organization", nodeId) }));

  await assert.rejects(
    createGitHubBacklog({ FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_ID: nodeId, FORGE_BACKLOG_TOKEN: token }, seam.fetch),
    (error: unknown) => error instanceof BacklogConfigurationError && /FORGE_BACKLOG_PROJECT_URL/.test(error.message) && !error.message.includes(nodeId),
  );
  assert.deepEqual(seam.calls, []);

  const blank = graphqlFetch(() => ({ body: resolved("organization", nodeId) }));
  await assert.rejects(
    createGitHubBacklog({ ...env, FORGE_BACKLOG_PROJECT_URL: "   " }, blank.fetch),
    (error: unknown) => error instanceof BacklogConfigurationError && /FORGE_BACKLOG_PROJECT_URL/.test(error.message),
  );
  assert.deepEqual(blank.calls, []);
});

test("every unsupported Project URL is refused locally without one request", async () => {
  const rejected = [
    "PVT_kwH_private1",
    "7",
    "github.com/orgs/acme/projects/7",
    "http://github.com/orgs/acme/projects/7",
    "https://github.com:8443/orgs/acme/projects/7",
    "https://api.github.com/orgs/acme/projects/7",
    "https://github.com/organizations/30387749/projects/7",
    "https://ghe.example.com/orgs/acme/projects/7",
    "https://github.com/orgs//projects/7",
    "https://github.com/orgs/acme/projects",
    "https://github.com/orgs/acme/projects/0",
    "https://github.com/orgs/acme/projects/-3",
    "https://github.com/orgs/acme/projects/2.5",
    "https://github.com/orgs/acme/projects/2147483648",
    "https://github.com/orgs/acme/projects/7/views/0",
    "https://github.com/acme/backlog/issues/1",
    "https://github.com/orgs/acme/projects/7/extra",
    "not a url",
    "https://ghp_backlog_secret_9f2c@github.com/orgs/acme/projects/7",
  ];
  for (const value of rejected) {
    const seam = graphqlFetch(() => ({ body: resolved("organization", nodeId) }));

    await assert.rejects(
      createGitHubBacklog({ ...env, FORGE_BACKLOG_PROJECT_URL: value }, seam.fetch),
      (error: unknown) => error instanceof BacklogConfigurationError
        && /FORGE_BACKLOG_PROJECT_URL/.test(error.message)
        && !error.message.includes(value),
      `${value} is refused without echoing the input`,
    );
    assert.deepEqual(seam.calls, [], `${value} makes no request`);
  }
});

test("repository and token configuration is validated before the Project lookup is issued", async () => {
  for (const broken of [
    { ...env, FORGE_BACKLOG_REPOSITORY: "  " },
    { ...env, FORGE_BACKLOG_REPOSITORY: "acme" },
    { ...env, FORGE_BACKLOG_TOKEN: "" },
  ]) {
    const seam = graphqlFetch(() => ({ body: resolved("organization", nodeId) }));

    await assert.rejects(
      createGitHubBacklog(broken, seam.fetch),
      (error: unknown) => error instanceof BacklogConfigurationError,
      JSON.stringify(broken),
    );
    assert.deepEqual(seam.calls, [], "local configuration is rejected before any network access");
  }
});

test("a resolution GraphQL error is a structured redacted failure with no board write", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ errors: [{ type: "BAD_CREDENTIALS", message: `expired token ${token} rejected` }] }) }));

  await assert.rejects(
    createGitHubBacklog(env, seam.fetch),
    (error: unknown) => error instanceof BacklogHttpError
      && error.operation === "resolving backlog Project URL"
      && error.stderr === "BAD_CREDENTIALS: expired token [redacted-token] rejected"
      && !error.message.includes(token),
  );
  assert.equal(seam.calls.length, 1);
});

test("a Project the token cannot see is a configuration failure naming the reference", async () => {
  for (const body of [JSON.stringify({ data: { organization: null } }), JSON.stringify({ data: { organization: { projectV2: null } } })]) {
    const seam = graphqlFetch(() => ({ body }));

    await assert.rejects(
      createGitHubBacklog(env, seam.fetch),
      (error: unknown) => error instanceof BacklogConfigurationError
        && /acme/u.test(error.message)
        && /7/u.test(error.message)
        && /\binaccessible\b/iu.test(error.message),
      body,
    );
    assert.equal(seam.calls.length, 1);
  }
});

test("a personal Project the token cannot see is a configuration failure", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ data: { user: { projectV2: null } } }) }));

  await assert.rejects(
    createGitHubBacklog({ ...env, FORGE_BACKLOG_PROJECT_URL: "https://github.com/users/octocat/projects/12" }, seam.fetch),
    (error: unknown) => error instanceof BacklogConfigurationError && /octocat/u.test(error.message) && /12/u.test(error.message),
  );
  assert.equal(seam.calls.length, 1);
});

test("a resolved node id that is empty is a malformed response, not a silent identity", async () => {
  const seam = graphqlFetch(() => ({ body: resolved("organization", "") }));

  await assert.rejects(
    createGitHubBacklog(env, seam.fetch),
    (error: unknown) => error instanceof BacklogHttpError && /did not match the expected shape/u.test(error.message),
  );
  assert.equal(seam.calls.length, 1);
});

test("an unauthorized resolution HTTP status is a scope configuration failure", async () => {
  const seam = graphqlFetch(() => ({ status: 403, body: "Forbidden" }));

  await assert.rejects(
    createGitHubBacklog(env, seam.fetch),
    (error: unknown) => error instanceof BacklogConfigurationError && /`project` scope/u.test(error.message),
  );
  assert.equal(seam.calls.length, 1);
});

test("a transport failure during resolution keeps redacted structured diagnostics", async () => {
  const failing: Fetch = async () => {
    throw new Error(`socket hang up near ${token}`);
  };

  await assert.rejects(
    createGitHubBacklog(env, failing),
    (error: unknown) => error instanceof BacklogHttpError && error.status === 0 && error.stderr === "socket hang up near [redacted-token]",
  );
});
