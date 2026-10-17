import { z } from "zod";
import { redactSecrets } from "../../shared/redact-secret.js";
import type { Fetch } from "../git-provider/git-provider.js";
import { BacklogConfigurationError, BacklogConflictError, BacklogHttpError } from "./github-backlog-errors.js";
import type { BacklogComment, BacklogIssue, BacklogProjectEntry, BacklogProjectItem, BacklogStatusField, BacklogStatusOption, GitHubBacklog, NewComment } from "./github-backlog-types.js";

// Private GitHub backlog transport: REST for issues and comments, GraphQL Projects v2 for board
// status. Mechanical only — it returns raw records and typed failures, never ticket content,
// scheduling policy, or status transitions. Reads are unrestricted; every write revalidates that
// both configured resources are private first, so a public backlog can never receive ticket text.

const API_BASE = "https://api.github.com";
const GRAPHQL_URL = `${API_BASE}/graphql`;
const PAGE_SIZE = 100;
const MAX_COMMENT_LENGTH = 65536;
const STATUS_FIELD_NAME = "Status";
const repositoryPattern = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

const repositorySchema = z.object({ private: z.boolean(), full_name: z.string().min(1) });
const issueFields = {
  number: z.number().int(),
  node_id: z.string().min(1),
  html_url: z.string().min(1),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  state_reason: z.string().nullable().optional(),
  updated_at: z.string().min(1),
  user: z.object({ login: z.string() }).nullable().optional(),
};
const issueSchema = z.object(issueFields);
// The issues endpoint returns pull requests too; only its entries carry a `pull_request` key.
const issueListItemSchema = z.object({ ...issueFields, pull_request: z.unknown().optional() });
const commentSchema = z.object({
  id: z.number().int(),
  node_id: z.string().min(1),
  html_url: z.string().min(1),
  body: z.string().nullable(),
  created_at: z.string().min(1),
  user: z.object({ login: z.string() }).nullable().optional(),
});

const projectNodeSchema = z.object({
  node: z
    .object({
      id: z.string(),
      number: z.number().int(),
      title: z.string(),
      url: z.string(),
      public: z.boolean(),
      viewerCanUpdate: z.boolean(),
      fields: z
        .object({
          nodes: z
            .array(
              z
                .object({
                  id: z.string(),
                  name: z.string(),
                  options: z.array(z.object({ id: z.string(), name: z.string() })),
                })
                .partial()
                .passthrough(),
            )
            .default([]),
        })
        .optional(),
    })
    .nullable(),
});
const projectItemsSchema = z.object({
  node: z
    .object({
      items: z.object({
        nodes: z
          .array(
            z.object({
              id: z.string(),
              content: z.object({ id: z.string().optional(), number: z.number().optional() }).nullable().optional(),
              fieldValues: z
                .object({
                  nodes: z
                    .array(
                      z
                        .object({
                          name: z.string().optional(),
                          optionId: z.string().nullable().optional(),
                          field: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable().optional(),
                        })
                        .partial()
                        .passthrough(),
                    )
                    .default([]),
                })
                .optional(),
            }),
          )
          .default([]),
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable().optional() }),
      }),
    })
    .nullable(),
});
const itemNodeSchema = z.object({
  node: z
    .object({
      id: z.string(),
      fieldValues: z
        .object({
          nodes: z
            .array(
              z
                .object({
                  name: z.string().optional(),
                  optionId: z.string().nullable().optional(),
                  field: z.object({ id: z.string().optional(), name: z.string().optional() }).nullable().optional(),
                })
                .partial()
                .passthrough(),
            )
            .default([]),
        })
        .optional(),
    })
    .nullable(),
});
const addedItemSchema = z.object({ addProjectV2ItemById: z.object({ item: z.object({ id: z.string() }) }) });
const updatedItemSchema = z.object({ updateProjectV2ItemFieldValue: z.object({ projectV2Item: z.object({ id: z.string() }) }) });

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One Project single-select value extracted from an item's `fieldValues` connection. */
function statusValue(nodes: readonly unknown[]): BacklogStatusOption | undefined {
  for (const raw of nodes) {
    const value = raw as { name?: string | undefined; optionId?: string | null | undefined; field?: { name?: string | undefined } | null | undefined };
    if (value.field?.name !== STATUS_FIELD_NAME) continue;
    if (typeof value.optionId !== "string" || value.optionId.length === 0) continue;
    return { optionId: value.optionId, name: value.name ?? "" };
  }
  return undefined;
}

/** The credential-bearing seam every GitHub request needs; `secrets` is what diagnostics must never expose. */
type GitHubTransport = Readonly<{
  fetchImpl: Fetch;
  token: string;
  secrets: readonly string[];
}>;

function authHeaders(transport: GitHubTransport, withBody: boolean): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${transport.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sandcastle-runner",
    ...(withBody ? { "Content-Type": "application/json" } : {}),
  };
}

function httpFailure(transport: GitHubTransport, operation: string, command: string, status: number, body: string, cause: unknown): BacklogHttpError {
  return new BacklogHttpError(
    { operation, command, status, stdout: redactSecrets(transport.secrets, body), stderr: redactSecrets(transport.secrets, `HTTP ${status}`) },
    new Error(redactSecrets(transport.secrets, toMessage(cause))),
  );
}

function transportFailure(transport: GitHubTransport, operation: string, command: string, cause: unknown): BacklogHttpError {
  return new BacklogHttpError(
    { operation, command, status: 0, stdout: "", stderr: redactSecrets(transport.secrets, toMessage(cause)) },
    new Error(redactSecrets(transport.secrets, toMessage(cause))),
  );
}

/** One GraphQL exchange against the fixed endpoint. Project errors arrive with HTTP 200, so the payload envelope is authoritative. */
async function graphqlRequest<T>(
  transport: GitHubTransport,
  schema: z.ZodType<T>,
  operation: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const command = `POST ${GRAPHQL_URL} ${operation}`;
  let response: Response;
  try {
    response = await transport.fetchImpl(GRAPHQL_URL, { method: "POST", headers: authHeaders(transport, true), body: JSON.stringify({ query, variables }) });
  } catch (error) {
    throw transportFailure(transport, operation, `POST ${GRAPHQL_URL}`, error);
  }
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new BacklogConfigurationError(
      `Backlog token cannot authorize ${operation} at ${GRAPHQL_URL} (HTTP ${response.status}). Projects v2 requires a classic PAT with the \`project\` scope; fine-grained PATs cannot access it.`,
    );
  }
  if (!response.ok) throw httpFailure(transport, operation, command, response.status, text, new Error(`GitHub GraphQL request failed with HTTP ${response.status}.`));

  let envelope: { data?: unknown; errors?: { message?: string; type?: string }[] };
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch (error) {
    throw httpFailure(transport, operation, command, response.status, text, new Error(`GitHub GraphQL response was not JSON: ${toMessage(error)}`));
  }
  if (envelope.errors !== undefined && envelope.errors.length > 0) {
    const detail = redactSecrets(transport.secrets, envelope.errors.map((entry) => [entry.type, entry.message].filter((part) => part !== undefined && part.length > 0).join(": ")).join("; "));
    throw new BacklogHttpError(
      { operation, command, status: response.status, stdout: redactSecrets(transport.secrets, text), stderr: detail },
      new Error(`GitHub GraphQL reported an error for ${operation}: ${detail}`),
    );
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw httpFailure(transport, operation, command, response.status, text, new Error(`GitHub GraphQL returned no data for ${operation}.`));
  }
  try {
    return schema.parse(envelope.data) as T;
  } catch (error) {
    throw httpFailure(transport, operation, command, response.status, text, new Error(`GitHub GraphQL data for ${operation} did not match the expected shape: ${toMessage(error)}`));
  }
}

/** GitHub backlog transport over an injectable fetch seam. */
export class GitHubBacklogClient implements GitHubBacklog {
  readonly secrets: readonly string[];

  private readonly transport: GitHubTransport;

  constructor(
    readonly repository: string,
    readonly projectId: string,
    token: string,
    fetchImpl: Fetch = globalThis.fetch,
  ) {
    this.transport = { fetchImpl, token, secrets: [token] };
    this.secrets = this.transport.secrets;
  }

  /** One REST exchange with redacted structured failures; 404 yields `undefined` so each caller decides what absence means. */
  private async rest<T>(schema: z.ZodType<T>, operation: string, method: string, path: string, payload?: unknown): Promise<T | undefined> {
    const command = `${method} ${API_BASE}${path}`;
    let response: Response;
    try {
      response = await this.transport.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: authHeaders(this.transport, payload !== undefined),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
    } catch (error) {
      throw transportFailure(this.transport, operation, command, error);
    }
    const text = await response.text();
    if (response.status === 404) return undefined;
    if (response.status === 401 || response.status === 403) {
      // A fine-grained PAT cannot reach Projects v2 at all, and private issues need the classic
      // `repo` scope, so 401/403 is operator configuration, never a retry.
      throw new BacklogConfigurationError(
        `Backlog token cannot authorize ${operation} at ${command} (HTTP ${response.status}). FORGE_BACKLOG_TOKEN needs the classic \`repo\` scope for private issues and the \`project\` scope for the Project. ${redactSecrets(this.secrets, text)}`,
      );
    }
    if (!response.ok) throw httpFailure(this.transport, operation, command, response.status, text, new Error(`GitHub backlog request failed with HTTP ${response.status}.`));
    let parsed: T;
    try {
      parsed = schema.parse(JSON.parse(text)) as T;
    } catch (error) {
      throw httpFailure(this.transport, operation, command, response.status, text, new Error(`GitHub backlog response did not match the expected shape: ${toMessage(error)}`));
    }
    return parsed;
  }

  /** One GraphQL exchange on this transport's credential. */
  private graphql<T>(schema: z.ZodType<T>, operation: string, query: string, variables: Record<string, unknown>): Promise<T> {
    return graphqlRequest(this.transport, schema, operation, query, variables);
  }

  /** Repository privacy and identity; a missing or invisible repository is a configuration failure. */
  async validateRepository(): Promise<{ private: boolean; fullName: string }> {
    const parsed = await this.rest(repositorySchema, "reading backlog repository", "GET", `/repos/${this.repository}`);
    if (parsed === undefined) {
      throw new BacklogConfigurationError(`Backlog repository ${this.repository} does not exist or the backlog token cannot see it.`);
    }
    return { private: parsed.private, fullName: parsed.full_name };
  }

  /** Fail closed before any outbound write: the repository must be private and the Project private and updatable. */
  private async requirePrivateBacklog(operation: string): Promise<void> {
    const repository = await this.validateRepository();
    if (!repository.private) {
      throw new BacklogConfigurationError(`Refusing ${operation}: backlog repository ${repository.fullName} is public, so ticket content would be published.`);
    }
    const project = await this.projectNode(operation);
    if (project.public) {
      throw new BacklogConfigurationError(`Refusing ${operation}: backlog Project ${this.projectId} is public, so ticket content would be published.`);
    }
    if (!project.viewerCanUpdate) {
      throw new BacklogConfigurationError(`Refusing ${operation}: backlog Project ${this.projectId} is not updatable with the configured backlog token.`);
    }
  }

  private async projectNode(operation: string): Promise<z.infer<typeof projectNodeSchema>["node"] & {}> {
    const data = await this.graphql(
      projectNodeSchema,
      operation,
      `query ProjectNode($id: ID!) { node(id: $id) { ... on ProjectV2 { id number title url public viewerCanUpdate fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } } } } }`,
      { id: this.projectId },
    );
    if (data.node === null) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} is inaccessible: the node is not a Project V2 the backlog token can read. Projects v2 requires a classic PAT with the \`project\` scope.`);
    }
    return data.node;
  }

  /** Require exactly one Status single-select field whose options contain every required name once. */
  async validateProject(requiredStatuses: readonly string[]): Promise<BacklogStatusField> {
    const project = await this.projectNode("reading backlog Project");
    if (project.public) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} is public; the backlog must be a private Project.`);
    }
    const statusFields = (project.fields?.nodes ?? []).filter((field) => field.name === STATUS_FIELD_NAME);
    if (statusFields.length === 0) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} has no single-select \`${STATUS_FIELD_NAME}\` field, so issue status cannot be read or set.`);
    }
    if (statusFields.length > 1) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} has ${statusFields.length} \`${STATUS_FIELD_NAME}\` fields; exactly one is required.`);
    }
    const field = statusFields[0]!;
    const options: BacklogStatusOption[] = (field.options ?? []).map((option) => ({ optionId: option.id, name: option.name }));
    const duplicates = [...new Set(options.filter((option, index) => options.findIndex((other) => other.name === option.name) !== index).map((option) => option.name))];
    if (duplicates.length > 0) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} \`${STATUS_FIELD_NAME}\` field has duplicate options: ${duplicates.join(", ")}.`);
    }
    const missing = requiredStatuses.filter((required) => !options.some((option) => option.name === required));
    if (missing.length > 0) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} \`${STATUS_FIELD_NAME}\` field is missing required options: ${missing.join(", ")}.`);
    }
    return { fieldId: field.id ?? "", fieldName: field.name ?? STATUS_FIELD_NAME, options };
  }

  private toIssue(issue: z.infer<typeof issueSchema>): BacklogIssue {
    return {
      number: issue.number,
      nodeId: issue.node_id,
      url: issue.html_url,
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      stateReason: issue.state_reason ?? undefined,
      revision: issue.updated_at,
      author: issue.user?.login,
    };
  }

  /** Every issue in the backlog: pull requests excluded, pages consumed to exhaustion, node ids deduplicated. */
  async listIssues(): Promise<readonly BacklogIssue[]> {
    const issues: BacklogIssue[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const entries = await this.rest(
        z.array(issueListItemSchema),
        "listing backlog issues",
        "GET",
        `/repos/${this.repository}/issues?state=all&per_page=${PAGE_SIZE}&page=${page}`,
      ) ?? [];
      for (const entry of entries) {
        // Pull requests share the issues endpoint; only their entries carry a `pull_request` key.
        if (entry.pull_request !== undefined || seen.has(entry.node_id)) continue;
        seen.add(entry.node_id);
        issues.push(this.toIssue(entry));
      }
      if (entries.length < PAGE_SIZE) return issues;
    }
  }

  async getIssue(number: number): Promise<BacklogIssue | undefined> {
    const parsed = await this.rest(issueSchema, `reading backlog issue ${number}`, "GET", `/repos/${this.repository}/issues/${number}`);
    return parsed === undefined ? undefined : this.toIssue(parsed);
  }

  async createIssue(title: string, body: string): Promise<{ number: number; nodeId: string; url: string }> {
    await this.requirePrivateBacklog("creating a backlog issue");
    const parsed = await this.rest(issueSchema, "creating a backlog issue", "POST", `/repos/${this.repository}/issues`, { title, body });
    if (parsed === undefined) {
      throw new BacklogConfigurationError(`Backlog repository ${this.repository} rejected issue creation with HTTP 404; it does not accept issues.`);
    }
    return { number: parsed.number, nodeId: parsed.node_id, url: parsed.html_url };
  }

  /** Compare-and-set body update: re-read first, send no PATCH on a revision mismatch, verify the stored body afterwards. */
  async updateIssueBody(number: number, body: string, expectedRevision: string): Promise<BacklogIssue> {
    await this.requirePrivateBacklog(`updating backlog issue ${number}`);
    const before = await this.getIssue(number);
    if (before === undefined) {
      throw new BacklogConfigurationError(`Backlog issue ${number} no longer exists, so its body cannot be updated.`);
    }
    if (before.revision !== expectedRevision) {
      throw new BacklogConflictError(
        `Backlog issue ${number} changed externally before the update: expected revision ${expectedRevision}, found ${before.revision}. No update was sent.`,
      );
    }
    await this.rest(issueSchema, `updating backlog issue ${number}`, "PATCH", `/repos/${this.repository}/issues/${number}`, { body });
    const after = await this.getIssue(number);
    const readBack = `GET ${API_BASE}/repos/${this.repository}/issues/${number}`;
    if (after === undefined) {
      throw new BacklogHttpError(
        { operation: `verifying backlog issue ${number} update`, command: readBack, status: 404, stdout: "", stderr: "Issue is gone after the update." },
        new Error(`Backlog issue ${number} disappeared during the update.`),
      );
    }
    if (after.body !== body) {
      throw new BacklogHttpError(
        { operation: `verifying backlog issue ${number} update`, command: readBack, status: 200, stdout: redactSecrets(this.secrets, after.title), stderr: `Stored revision ${after.revision} does not carry the submitted body.` },
        new Error(`Backlog issue ${number} body read-back is not the submitted body.`),
      );
    }
    return after;
  }

  async createComment(number: number, body: string): Promise<NewComment> {
    if (body.length > MAX_COMMENT_LENGTH) {
      throw new BacklogConfigurationError(
        `Comment for backlog issue ${number} is ${body.length} characters and exceeds the GitHub limit of ${MAX_COMMENT_LENGTH}; split it before posting. No request was sent.`,
      );
    }
    await this.requirePrivateBacklog(`commenting on backlog issue ${number}`);
    const parsed = await this.rest(commentSchema, `commenting on backlog issue ${number}`, "POST", `/repos/${this.repository}/issues/${number}/comments`, { body });
    if (parsed === undefined) {
      throw new BacklogConfigurationError(`Backlog issue ${number} rejected the comment with HTTP 404; it no longer exists.`);
    }
    return { id: parsed.id, url: parsed.html_url };
  }

  /** Every comment on one issue, pages consumed to exhaustion and node ids deduplicated. */
  async listComments(number: number): Promise<readonly BacklogComment[]> {
    const comments: BacklogComment[] = [];
    const seen = new Set<string>();
    for (let page = 1; ; page += 1) {
      const entries = await this.rest(
        z.array(commentSchema),
        `listing backlog issue ${number} comments`,
        "GET",
        `/repos/${this.repository}/issues/${number}/comments?per_page=${PAGE_SIZE}&page=${page}`,
      ) ?? [];
      for (const entry of entries) {
        if (seen.has(entry.node_id)) continue;
        seen.add(entry.node_id);
        comments.push({ id: entry.id, nodeId: entry.node_id, url: entry.html_url, body: entry.body ?? "", author: entry.user?.login, createdAt: entry.created_at });
      }
      if (entries.length < PAGE_SIZE) return comments;
    }
  }

  async closeIssueCompleted(number: number): Promise<void> {
    await this.requirePrivateBacklog(`closing backlog issue ${number}`);
    await this.rest(
      issueSchema,
      `closing backlog issue ${number}`,
      "PATCH",
      `/repos/${this.repository}/issues/${number}`,
      { state: "closed", state_reason: "completed" },
    );
  }

  /** Walk the Project items connection for the issue's node id and read its current Status value. */
  async findProjectItem(issueNodeId: string): Promise<BacklogProjectItem | undefined> {
    let cursor: string | undefined;
    for (;;) {
      const data = await this.graphql(
        projectItemsSchema,
        "reading backlog Project items",
        `query ProjectItems($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) { nodes { id content { ... on Issue { id number } } fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { id name } } name optionId } } } } pageInfo { hasNextPage endCursor } } } } }`,
        { id: this.projectId, ...(cursor === undefined ? {} : { cursor }) },
      );
      if (data.node === null) {
        throw new BacklogConfigurationError(`Backlog Project ${this.projectId} is inaccessible: the node is not a Project V2 the backlog token can read.`);
      }
      for (const item of data.node.items.nodes) {
        if (item.content?.id !== issueNodeId) continue;
        return { itemId: item.id, status: statusValue(item.fieldValues?.nodes ?? []) };
      }
      const endCursor = data.node.items.pageInfo.endCursor;
      if (!data.node.items.pageInfo.hasNextPage || endCursor === null || endCursor === undefined || endCursor.length === 0) return undefined;
      cursor = endCursor;
    }
  }

  /** Read every Project item with its issue identity and Status in one paginated walk. */
  async listProjectItems(): Promise<readonly BacklogProjectEntry[]> {
    const entries: BacklogProjectEntry[] = [];
    let cursor: string | undefined;
    for (;;) {
      const data = await this.graphql(
        projectItemsSchema,
        "reading backlog Project statuses",
        `query ProjectItems($id: ID!, $cursor: String) { node(id: $id) { ... on ProjectV2 { items(first: 100, after: $cursor) { nodes { id content { ... on Issue { id number } } fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { id name } } name optionId } } } } pageInfo { hasNextPage endCursor } } } } }`,
        { id: this.projectId, ...(cursor === undefined ? {} : { cursor }) },
      );
      if (data.node === null) {
        throw new BacklogConfigurationError(`Backlog Project ${this.projectId} is inaccessible: the node is not a Project V2 the backlog token can read.`);
      }
      for (const item of data.node.items.nodes) {
        if (item.content?.id === undefined || item.content?.number === undefined) continue;
        entries.push({ issueNodeId: item.content.id, issueNumber: item.content.number, itemId: item.id, status: statusValue(item.fieldValues?.nodes ?? []) });
      }
      const endCursor = data.node.items.pageInfo.endCursor;
      if (!data.node.items.pageInfo.hasNextPage || endCursor === null || endCursor === undefined || endCursor.length === 0) return entries;
      cursor = endCursor;
    }
  }

  /** Attach the issue when it has no item, set the Status option, then read the item back and require the requested option. */
  async setProjectStatus(issueNodeId: string, optionId: string): Promise<void> {
    await this.requirePrivateBacklog("setting a backlog Project status");
    const project = await this.projectNode("resolving backlog Project status field");
    const field = (project.fields?.nodes ?? []).find((candidate) => candidate.name === STATUS_FIELD_NAME);
    if (field?.id === undefined || field.id.length === 0) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} has no single-select \`${STATUS_FIELD_NAME}\` field, so no status can be set.`);
    }
    const fieldId = field.id;
    if (!(field.options ?? []).some((option) => option.id === optionId)) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} \`${STATUS_FIELD_NAME}\` field has no option id ${optionId}.`);
    }

    const existing = await this.findProjectItem(issueNodeId);
    const itemId = existing?.itemId
      ?? (await this.graphql(addedItemSchema, "adding an issue to the backlog Project", `mutation AddItem($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } } }`, { projectId: this.projectId, contentId: issueNodeId })).addProjectV2ItemById.item.id;

    await this.graphql(
      updatedItemSchema,
      "setting a backlog Project status",
      `mutation SetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } } }`,
      { projectId: this.projectId, itemId, fieldId, optionId },
    );

    const readBack = await this.graphql(
      itemNodeSchema,
      "verifying a backlog Project status",
      `query ItemNode($id: ID!) { node(id: $id) { ... on ProjectV2Item { id fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { id name } } name optionId } } } } } }`,
      { id: itemId },
    );
    const stored = readBack.node === null ? undefined : statusValue(readBack.node.fieldValues?.nodes ?? []);
    if (stored?.optionId !== optionId) {
      throw new BacklogHttpError(
        { operation: "verifying a backlog Project status", command: `POST ${GRAPHQL_URL} verifying a backlog Project status`, status: 200, stdout: "", stderr: `Project item ${itemId} reports ${stored === undefined ? "no" : `"${stored.name}"`} Status after the write, not option ${optionId}.` },
        new Error(`Backlog Project status write for item ${itemId} was not persisted.`),
      );
    }
  }
}

/** The Project V2 reference a pasted browser URL identifies: owner kind, owner login, and project number. */
type ProjectReference = Readonly<{
  kind: "organization" | "user";
  owner: string;
  number: number;
}>;

const projectPathPattern = /^\/(orgs|users)\/([^/]+)\/projects\/([^/]+)(?:\/views\/([^/]+))?\/?$/u;
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const MAX_GRAPHQL_INT = 2_147_483_647;
const projectUrlGuidance = "FORGE_BACKLOG_PROJECT_URL must be the private Project V2 board URL, for example https://github.com/orgs/<owner>/projects/<number> (a trailing /views/<number> is allowed). See .env.example.";
const ownerProjectSchema = z.object({ projectV2: z.object({ id: z.string().min(1) }).nullable() }).nullable();
const projectRefSchema = z.object({ organization: ownerProjectSchema.nullish(), user: ownerProjectSchema.nullish() });

/** One positive GraphQL `Int` path segment; zero, sign, decimals, and overflow have no Project. */
function projectNumber(segment: string | undefined): number | undefined {
  if (segment === undefined || !/^\d+$/u.test(segment)) return undefined;
  const number = Number(segment);
  return number >= 1 && number <= MAX_GRAPHQL_INT ? number : undefined;
}

/**
 * Interpret the reference the operator pasted, locally, and never fetch it. Only the canonical browser
 * grammar is accepted: HTTPS on `github.com`, no credential in the authority, no non-default port, and
 * `/orgs/<owner>/projects/<number>` or `/users/<owner>/projects/<number>` with an optional view segment.
 * Query strings and fragments are browser filtering rather than board identity, so they are ignored. The
 * rejected value is never echoed: a pasted URL can carry a credential in its authority.
 */
function parseProjectUrl(value: string): ProjectReference {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BacklogConfigurationError(projectUrlGuidance);
  }
  const path = projectPathPattern.exec(url.pathname);
  const owner = path?.[2] ?? "";
  const number = projectNumber(path?.[3]);
  const view = path?.[4];
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username.length > 0 || url.password.length > 0 || url.port.length > 0
    || path === null || !ownerPattern.test(owner) || number === undefined || (view !== undefined && projectNumber(view) === undefined)) {
    throw new BacklogConfigurationError(projectUrlGuidance);
  }
  return { kind: path[1] === "orgs" ? "organization" : "user", owner, number };
}

/** One read-only lookup of the node id behind a reference, through the fixed GraphQL endpoint. */
async function resolveProjectId(transport: GitHubTransport, reference: ProjectReference): Promise<string> {
  const data = await graphqlRequest(
    transport,
    projectRefSchema,
    "resolving backlog Project URL",
    `query ResolveProject($login: String!, $number: Int!) { ${reference.kind}(login: $login) { projectV2(number: $number) { id } } }`,
    { login: reference.owner, number: reference.number },
  );
  const owner = reference.kind === "organization" ? data.organization : data.user;
  const project = owner === null || owner === undefined ? null : owner.projectV2;
  if (project === null) {
    throw new BacklogConfigurationError(`Backlog Project ${reference.number} of ${reference.kind} ${reference.owner} is inaccessible: it is not a Project V2 the backlog token can read. Projects v2 requires a classic PAT with the \`project\` scope.`);
  }
  return project.id;
}

/**
 * Build the configured backlog transport: every local setting is validated before the single read-only
 * Project URL lookup, and the result carries the resolved node id as its immutable identity. A missing
 * setting names its variable, the token is never echoed, and a rejected URL is never echoed.
 */
export async function createGitHubBacklog(env: NodeJS.ProcessEnv, fetchImpl: Fetch = globalThis.fetch): Promise<GitHubBacklog> {
  const repository = env.FORGE_BACKLOG_REPOSITORY?.trim() ?? "";
  if (repository.length === 0) {
    throw new BacklogConfigurationError("FORGE_BACKLOG_REPOSITORY must be the private backlog `owner/repository`. See .env.example.");
  }
  if (!repositoryPattern.test(repository)) {
    throw new BacklogConfigurationError(`FORGE_BACKLOG_REPOSITORY must be \`owner/repository\`; got ${repository}.`);
  }
  const projectUrl = env.FORGE_BACKLOG_PROJECT_URL?.trim() ?? "";
  if (projectUrl.length === 0) {
    throw new BacklogConfigurationError(projectUrlGuidance);
  }
  const token = env.FORGE_BACKLOG_TOKEN?.trim() ?? "";
  if (token.length === 0) {
    throw new BacklogConfigurationError("FORGE_BACKLOG_TOKEN must be a classic PAT with the `repo` and `project` scopes. See .env.example.");
  }
  const reference = parseProjectUrl(projectUrl);
  const projectId = await resolveProjectId({ fetchImpl, token, secrets: [token] }, reference);
  return new GitHubBacklogClient(repository, projectId, token, fetchImpl);
}
