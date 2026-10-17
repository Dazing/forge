import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSchema, graphqlSync } from "graphql";
import { BacklogConfigurationError, BacklogHttpError, createGitHubBacklog } from "./index.js";
import type { Fetch } from "../git-provider/git-provider.js";

const token = "ghp_backlog_secret_9f2c";
const projectId = "PVT_kwH_private1";
const env = { FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_URL: "https://github.com/orgs/acme/projects/7", FORGE_BACKLOG_TOKEN: token };
const resolvedProject = JSON.stringify({ data: { organization: { projectV2: { id: projectId } } } });
const STATUS_NAMES = ["Backlog", "Ready", "In progress", "In review", "Done", "Blocked"];
const optionId = (name: string): string => `OPT_${name.toUpperCase().replace(/ /g, "_")}`;

type GraphqlCall = { name: string; query: string; variables: Record<string, unknown> };

/** GraphQL fetch seam: responses are selected by operation name, so each test scripts one field of the envelope. */
function graphqlFetch(respond: (call: GraphqlCall) => { status?: number; body: string }): { fetch: Fetch; calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  return {
    calls,
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      // Constructing the transport resolves the Project URL; that lookup is setup, never the Project behavior under test.
      if (payload.query.includes("ResolveProject")) return new Response(resolvedProject, { status: 200, statusText: "Status" });
      const call: GraphqlCall = { name: /(?:query|mutation)\s+(\w+)/.exec(payload.query)?.[1] ?? "anonymous", query: payload.query, variables: payload.variables };
      calls.push(call);
      const { status = 200, body } = respond(call);
      return new Response(body, { status, statusText: "Status" });
    },
  };
}

function projectFieldResponse(options: { id: string; name: string }[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      node: {
        id: projectId,
        number: 7,
        title: "Backlog",
        url: "https://github.com/orgs/acme/projects/7",
        public: false,
        viewerCanUpdate: true,
        fields: { nodes: [{ __typename: "ProjectV2SingleSelectField", id: "PVTSSF_field", name: "Status", options, ...overrides }] },
      },
    },
  });
}

const allOptions = STATUS_NAMES.map((name) => ({ id: optionId(name), name }));
const privateRepo = JSON.stringify({ private: true, full_name: "acme/backlog" });

test("validates the Project status field and returns every configured option", async () => {
  const seam = graphqlFetch(() => ({ body: projectFieldResponse(allOptions) }));

  const field = await (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES);

  assert.deepEqual(field, { fieldId: "PVTSSF_field", fieldName: "Status", options: allOptions.map((option) => ({ optionId: option.id, name: option.name })) });
  assert.equal(seam.calls[0]!.name, "ProjectNode");
  assert.deepEqual(seam.calls[0]!.variables, { id: projectId });
});

test("a status field missing one required option is rejected by name", async () => {
  const seam = graphqlFetch(() => ({ body: projectFieldResponse(allOptions.filter((option) => option.name !== "In review")) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogConfigurationError && /missing required options: In review\./.test(error.message),
  );
});

test("duplicate status options are rejected by name", async () => {
  const seam = graphqlFetch(() => ({ body: projectFieldResponse([...allOptions, { id: "OPT_DONE_SECOND", name: "Done" }]) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogConfigurationError && /duplicate options: Done\./.test(error.message),
  );
});

test("a Project without a status field is a configuration failure", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ data: { node: { id: projectId, number: 7, title: "Backlog", url: "https://github.com/orgs/acme/projects/7", public: false, viewerCanUpdate: true, fields: { nodes: [{ __typename: "ProjectV2Text", id: "PVTSSF_text", name: "Ticket" }] } } } }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogConfigurationError && /has no single-select `Status` field/.test(error.message),
  );
});

test("an inaccessible Project node is a configuration failure", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ data: { node: null } }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogConfigurationError && /is inaccessible/.test(error.message),
  );
});

test("a public Project is rejected for status validation", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ data: { node: { id: projectId, number: 7, title: "Backlog", url: "https://github.com/orgs/acme/projects/7", public: true, viewerCanUpdate: true, fields: { nodes: [] } } } }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogConfigurationError && /is public; the backlog must be a private Project/.test(error.message),
  );
});

test("GraphQL errors arriving with HTTP 200 become structured failures named by operation", async () => {
  const seam = graphqlFetch(() => ({ status: 200, body: JSON.stringify({ data: null, errors: [{ message: "Field 'public' is not defined", type: "GRAPHQL_VALIDATION_FAILED" }] }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogHttpError
      && error.status === 200
      && error.operation === "reading backlog Project"
      && error.stderr === "GRAPHQL_VALIDATION_FAILED: Field 'public' is not defined",
  );
});

test("a GraphQL payload with null data and no errors is a structured failure", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ data: null }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogHttpError && /returned no data/.test(error.message),
  );
});

test("a token inside a GraphQL error message is redacted", async () => {
  const seam = graphqlFetch(() => ({ body: JSON.stringify({ errors: [{ message: `expired token ${token} rejected`, type: "BAD_CREDENTIALS" }] }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogHttpError
      && error.stderr === "BAD_CREDENTIALS: expired token [redacted-token] rejected"
      && !error.message.includes(token)
      && !error.stdout.includes(token),
  );
});

test("a GraphQL transport rejection reports status zero", async () => {
  const failing: Fetch = async (_url, init) => {
    if (String(init.body).includes("ResolveProject")) return new Response(resolvedProject, { status: 200 });
    throw new Error(`socket hang up near ${token}`);
  };

  await assert.rejects(
    (await createGitHubBacklog(env, failing)).validateProject(STATUS_NAMES),
    (error: unknown) => error instanceof BacklogHttpError && error.status === 0 && error.stderr === "socket hang up near [redacted-token]",
  );
});

type RestCall = { url: string; method: string };

/** Combined seam: REST repository reads answer the privacy gate, GraphQL responses script Project behavior. */
function backlogFetch(repositoryPrivate: boolean, respond: (call: GraphqlCall) => { status?: number; body: string }): { fetch: Fetch; graphql: GraphqlCall[]; rest: RestCall[] } {
  const graphqlCalls: GraphqlCall[] = [];
  const rest: RestCall[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    if (init.body === undefined) {
      rest.push({ url, method: init.method ?? "GET" });
      return new Response(JSON.stringify({ private: repositoryPrivate, full_name: "acme/backlog" }), { status: 200 });
    }
    const payload = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
    // Constructing the transport resolves the Project URL; that lookup is setup, never the Project behavior under test.
    if (payload.query.includes("ResolveProject")) return new Response(resolvedProject, { status: 200, statusText: "Status" });
    const call: GraphqlCall = { name: /(?:query|mutation)\s+(\w+)/.exec(payload.query)?.[1] ?? "anonymous", query: payload.query, variables: payload.variables };
    graphqlCalls.push(call);
    const { status = 200, body } = respond(call);
    return new Response(body, { status, statusText: "Status" });
  };
  return { fetch: fetchImpl, graphql: graphqlCalls, rest };
}

const statusValueNode = (name: string, id: string): unknown => ({ __typename: "ProjectV2ItemFieldSingleSelectValue", name, optionId: id, field: { __typename: "ProjectV2FieldCommon", id: "PVTSSF_field", name: "Status" } });
const itemsResponse = (nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }): string => JSON.stringify({ data: { node: { items: { nodes, pageInfo } } } });

test("finds the project item for an issue across item pages and reads its status", async () => {
  const seam = graphqlFetch((call) => (call.variables.cursor === undefined
    ? { body: itemsResponse([{ id: "PVTI_1", content: { id: "I_NODE_other", number: 3 }, fieldValues: { nodes: [] } }], { hasNextPage: true, endCursor: "cur2" }) }
    : { body: itemsResponse([{ id: "PVTI_9", content: { id: "I_NODE_12", number: 12 }, fieldValues: { nodes: [statusValueNode("In progress", "OPT_IN_PROGRESS")] } }], { hasNextPage: false, endCursor: null }) }));

  const item = await (await createGitHubBacklog(env, seam.fetch)).findProjectItem("I_NODE_12");

  assert.deepEqual(item, { itemId: "PVTI_9", status: { optionId: "OPT_IN_PROGRESS", name: "In progress" } });
  assert.equal(seam.calls.length, 2);
  assert.deepEqual(seam.calls[1]!.variables, { id: projectId, cursor: "cur2" });
});

test("an attached issue with no status value reports an undefined status", async () => {
  const seam = graphqlFetch(() => ({ body: itemsResponse([{ id: "PVTI_9", content: { id: "I_NODE_12", number: 12 }, fieldValues: { nodes: [] } }], { hasNextPage: false, endCursor: null }) }));

  assert.deepEqual(await (await createGitHubBacklog(env, seam.fetch)).findProjectItem("I_NODE_12"), { itemId: "PVTI_9", status: undefined });
});

test("an issue that is not on the board has no project item", async () => {
  const seam = graphqlFetch(() => ({ body: itemsResponse([{ id: "PVTI_1", content: { id: "I_NODE_other", number: 3 }, fieldValues: { nodes: [] } }], { hasNextPage: false, endCursor: null }) }));

  assert.equal(await (await createGitHubBacklog(env, seam.fetch)).findProjectItem("I_NODE_12"), undefined);
});

test("setting a status attaches the issue, writes the option, and verifies the read-back", async () => {
  const seam = backlogFetch(true, (call) => {
    if (call.name === "ProjectNode") return { body: projectFieldResponse(allOptions) };
    if (call.name === "ProjectItems") return { body: itemsResponse([], { hasNextPage: false, endCursor: null }) };
    if (call.name === "AddItem") return { body: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_9" } } } }) };
    if (call.name === "SetStatus") return { body: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_9" } } } }) };
    return { body: JSON.stringify({ data: { node: { id: "PVTI_9", fieldValues: { nodes: [statusValueNode("In progress", "OPT_IN_PROGRESS")] } } } }) };
  });

  await (await createGitHubBacklog(env, seam.fetch)).setProjectStatus("I_NODE_12", "OPT_IN_PROGRESS");

  const addItem = seam.graphql.find((call) => call.name === "AddItem")!;
  assert.deepEqual(addItem.variables, { projectId, contentId: "I_NODE_12" });
  assert.deepEqual(seam.graphql.find((call) => call.name === "SetStatus")!.variables, { projectId, itemId: "PVTI_9", fieldId: "PVTSSF_field", optionId: "OPT_IN_PROGRESS" });
  assert.deepEqual(seam.graphql.map((call) => call.name), ["ProjectNode", "ProjectNode", "ProjectItems", "AddItem", "SetStatus", "ItemNode"]);
});

test("claim and blocked statuses persist through the GitHub single-select GraphQL input contract", async () => {
  const schema = buildSchema(`
    type Query { unused: Boolean }
    type Mutation {
      updateProjectV2ItemFieldValue(input: UpdateProjectV2ItemFieldValueInput!): UpdateProjectV2ItemFieldValuePayload
    }
    input UpdateProjectV2ItemFieldValueInput {
      projectId: ID!
      itemId: ID!
      fieldId: ID!
      value: ProjectV2FieldValue!
    }
    input ProjectV2FieldValue { singleSelectOptionId: String }
    type UpdateProjectV2ItemFieldValuePayload { projectV2Item: ProjectV2Item }
    type ProjectV2Item { id: ID! }
  `);
  let storedOption = allOptions.find((option) => option.name === "Ready")!;
  const seam = backlogFetch(true, (call) => {
    if (call.name === "ProjectNode") return { body: projectFieldResponse(allOptions) };
    const nodes = [statusValueNode(storedOption.name, storedOption.id)];
    if (call.name === "ProjectItems") {
      return { body: itemsResponse([{ id: "PVTI_9", content: { id: "I_NODE_12", number: 12 }, fieldValues: { nodes } }], { hasNextPage: false, endCursor: null }) };
    }
    if (call.name === "SetStatus") {
      const result = graphqlSync({
        schema,
        source: call.query,
        variableValues: call.variables,
        rootValue: {
          updateProjectV2ItemFieldValue: ({ input }: { input: { projectId: string; itemId: string; fieldId: string; value: { singleSelectOptionId: string } } }) => {
            assert.equal(input.projectId, projectId);
            assert.equal(input.itemId, "PVTI_9");
            assert.equal(input.fieldId, "PVTSSF_field");
            storedOption = allOptions.find((option) => option.id === input.value.singleSelectOptionId)!;
            return { projectV2Item: { id: input.itemId } };
          },
        },
      });
      return { body: JSON.stringify(result) };
    }
    assert.equal(call.name, "ItemNode");
    return { body: JSON.stringify({ data: { node: { id: "PVTI_9", fieldValues: { nodes } } } }) };
  });
  const backlog = await createGitHubBacklog(env, seam.fetch);
  for (const name of ["In progress", "Blocked"]) {
    await backlog.setProjectStatus("I_NODE_12", optionId(name));
    const item = await backlog.findProjectItem("I_NODE_12");
    assert.deepEqual(item?.status, { optionId: optionId(name), name });
  }
});

test("setting a status on an attached issue reuses its existing item", async () => {
  const seam = backlogFetch(true, (call) => {
    if (call.name === "ProjectNode") return { body: projectFieldResponse(allOptions) };
    if (call.name === "ProjectItems") return { body: itemsResponse([{ id: "PVTI_9", content: { id: "I_NODE_12", number: 12 }, fieldValues: { nodes: [statusValueNode("Backlog", "OPT_STAGING")] } }], { hasNextPage: false, endCursor: null }) };
    if (call.name === "SetStatus") return { body: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_9" } } } }) };
    return { body: JSON.stringify({ data: { node: { id: "PVTI_9", fieldValues: { nodes: [statusValueNode("Done", "OPT_DONE")] } } } }) };
  });

  await (await createGitHubBacklog(env, seam.fetch)).setProjectStatus("I_NODE_12", "OPT_DONE");

  assert.equal(seam.graphql.some((call) => call.name === "AddItem"), false);
});

test("a status read-back that is not the requested option fails structurally", async () => {
  const seam = backlogFetch(true, (call) => {
    if (call.name === "ProjectNode") return { body: projectFieldResponse(allOptions) };
    if (call.name === "ProjectItems") return { body: itemsResponse([{ id: "PVTI_9", content: { id: "I_NODE_12", number: 12 }, fieldValues: { nodes: [] } }], { hasNextPage: false, endCursor: null }) };
    if (call.name === "AddItem") return { body: JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_9" } } } }) };
    if (call.name === "SetStatus") return { body: JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_9" } } } }) };
    return { body: JSON.stringify({ data: { node: { id: "PVTI_9", fieldValues: { nodes: [statusValueNode("Blocked", "OPT_BLOCKED")] } } } }) };
  });

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).setProjectStatus("I_NODE_12", "OPT_DONE"),
    (error: unknown) => error instanceof BacklogHttpError
      && error.operation === "verifying a backlog Project status"
      && error.stderr === 'Project item PVTI_9 reports "Blocked" Status after the write, not option OPT_DONE.',
  );
});

test("an unknown status option id is rejected before any mutation", async () => {
  const seam = backlogFetch(true, (call) => (call.name === "ProjectNode" ? { body: projectFieldResponse(allOptions) } : { body: itemsResponse([], { hasNextPage: false, endCursor: null }) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).setProjectStatus("I_NODE_12", "OPT_MISSING"),
    (error: unknown) => error instanceof BacklogConfigurationError && /has no option id OPT_MISSING/.test(error.message),
  );
  assert.equal(seam.graphql.some((call) => call.name === "SetStatus"), false);
});

test("a public repository blocks a status write before any Project mutation", async () => {
  const seam = backlogFetch(false, () => ({ body: projectFieldResponse(allOptions) }));

  await assert.rejects(
    (await createGitHubBacklog(env, seam.fetch)).setProjectStatus("I_NODE_12", "OPT_DONE"),
    (error: unknown) => error instanceof BacklogConfigurationError && /is public, so ticket content would be published/.test(error.message),
  );
  assert.deepEqual(seam.graphql, []);
});
