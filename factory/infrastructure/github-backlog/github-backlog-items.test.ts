import assert from "node:assert/strict";
import { test } from "node:test";
import { BacklogConfigurationError, createGitHubBacklog } from "./index.js";
import type { Fetch } from "../git-provider/git-provider.js";

const token = "ghp_backlog_secret_9f2c";
const projectId = "PVT_kwH_private1";
const env = { FORGE_BACKLOG_REPOSITORY: "acme/backlog", FORGE_BACKLOG_PROJECT_ID: projectId, FORGE_BACKLOG_TOKEN: token };

type GraphqlCall = { name: string; variables: Record<string, unknown> };

function itemsFetch(pages: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }[]): { fetch: Fetch; calls: GraphqlCall[] } {
  const calls: GraphqlCall[] = [];
  return {
    calls,
    fetch: async (_url, init) => {
      const payload = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      const call: GraphqlCall = { name: /(?:query|mutation)\s+(\w+)/.exec(payload.query)?.[1] ?? "anonymous", variables: payload.variables };
      calls.push(call);
      const page = pages[calls.length - 1] ?? pages.at(-1)!;
      return new Response(JSON.stringify({ data: { node: { items: page } } }), { status: 200 });
    },
  };
}

const statusNode = (name: string, id: string): unknown => ({ __typename: "ProjectV2ItemFieldSingleSelectValue", name, optionId: id, field: { __typename: "ProjectV2FieldCommon", id: "PVTSSF_field", name: "Status" } });
const item = (itemId: string, nodeId: string, number: number, status?: { name: string; id: string }): unknown => ({
  id: itemId,
  content: { id: nodeId, number },
  fieldValues: { nodes: status === undefined ? [] : [statusNode(status.name, status.id)] },
});

test("reads every Project item with its issue identity and status in one paginated walk", async () => {
  const seam = itemsFetch([
    { nodes: [item("PVTI_1", "I_NODE_1", 1, { name: "Ready for development", id: "OPT_READY" }), item("PVTI_2", "I_NODE_2", 2)], pageInfo: { hasNextPage: true, endCursor: "cur2" } },
    { nodes: [item("PVTI_3", "I_NODE_3", 3, { name: "Blocked", id: "OPT_BLOCKED" })], pageInfo: { hasNextPage: false, endCursor: null } },
  ]);

  const entries = await createGitHubBacklog(env, seam.fetch).listProjectItems();

  assert.deepEqual(entries, [
    { issueNodeId: "I_NODE_1", issueNumber: 1, itemId: "PVTI_1", status: { optionId: "OPT_READY", name: "Ready for development" } },
    { issueNodeId: "I_NODE_2", issueNumber: 2, itemId: "PVTI_2", status: undefined },
    { issueNodeId: "I_NODE_3", issueNumber: 3, itemId: "PVTI_3", status: { optionId: "OPT_BLOCKED", name: "Blocked" } },
  ]);
  assert.equal(seam.calls.length, 2);
  assert.deepEqual(seam.calls[1]!.variables, { id: projectId, cursor: "cur2" });
});

test("items without issue content are skipped so only ticket issues are scheduled", async () => {
  const seam = itemsFetch([
    { nodes: [{ id: "PVTI_draft", content: null, fieldValues: { nodes: [] } }, item("PVTI_1", "I_NODE_1", 1)], pageInfo: { hasNextPage: false, endCursor: null } },
  ]);

  assert.deepEqual(await createGitHubBacklog(env, seam.fetch).listProjectItems(), [
    { issueNodeId: "I_NODE_1", issueNumber: 1, itemId: "PVTI_1", status: undefined },
  ]);
});

test("an inaccessible Project reports a configuration failure naming the project", async () => {
  const fetch: Fetch = async () => new Response(JSON.stringify({ data: { node: null } }), { status: 200 });

  await assert.rejects(
    createGitHubBacklog(env, fetch).listProjectItems(),
    (error: unknown) => error instanceof BacklogConfigurationError && error.message.includes(projectId),
  );
});
