import { BacklogConfigurationError, BacklogConflictError, BacklogHttpError, type BacklogComment, type BacklogIssue, type BacklogProjectEntry, type BacklogProjectItem, type BacklogStatusField, type GitHubBacklog, type NewComment } from "../../infrastructure/github-backlog/index.js";

// Test seam for the submission feature: an in-memory backlog that records every write, so tests prove
// zero-write guarantees, status transitions, and comment idempotency without network or credentials.

/** The six configured options the fake Project is seeded with, in board order. */
export const FAKE_STATUSES = ["Backlog", "Ready", "In progress", "In review", "Done", "Blocked"];

/** A stored issue, mutable so a fixture can simulate the author editing it between a read and a write. */
export type FakeIssue = { -readonly [K in keyof BacklogIssue]: BacklogIssue[K] };

/** How the fake transport answers the two startup gates. */
export type FakeBacklogBehaviour = Readonly<{
  repositoryPrivate?: boolean;
  repositoryFullName?: string;
  repositoryForbidden?: boolean;
  projectPublic?: boolean;
  projectForbidden?: boolean;
  projectReadOnly?: boolean;
  projectStatuses?: readonly string[];
  projectStatusField?: boolean;
  /** Simulates an external edit landing between the client's read and its compare-and-set update. */
  externalEditBeforeUpdate?: (issue: FakeIssue) => void;
  /** Simulates a comment write that fails with transport diagnostics carrying a token. */
  commentFailure?: string;
}>;

const URL_BASE = "https://github.com/acme/backlog/issues";

/** One recorded write request, in the order the client attempted them. */
export type FakeWrite = Readonly<{ operation: string; issueNumber?: number; optionId?: string; body?: string }>;

export class FakeBacklog implements GitHubBacklog {
  readonly repository = "acme/backlog";
  readonly projectId = "PVT_project_1";
  readonly secrets: readonly string[] = ["backlog_secret_xyz"];

  readonly issues: FakeIssue[] = [];
  readonly writes: FakeWrite[] = [];
  readonly reads: string[] = [];
  readonly statusWrites: string[] = [];
  private readonly comments = new Map<number, BacklogComment[]>();
  private readonly items = new Map<string, BacklogProjectItem>();
  private nextNumber = 100;

  constructor(private readonly behaviour: FakeBacklogBehaviour = {}) {}

  /** Seed one existing issue as the backlog already carried it. */
  seedIssue(body: string, options: Readonly<{ number?: number; revision?: string; status?: string }> = {}): FakeIssue {
    const number = options.number ?? this.nextNumber++;
    const issue: FakeIssue = {
      number,
      nodeId: `ISSIONODE_${number}`,
      url: `${URL_BASE}/${number}`,
      title: body.split("\n").find((line) => line.startsWith("# "))?.slice(2) ?? "seed",
      body,
      state: "open",
      stateReason: undefined,
      revision: options.revision ?? `rev-${number}`,
      author: "author",
    };
    this.issues.push(issue);
    this.items.set(issue.nodeId, { itemId: `ITEM_${number}`, status: options.status === undefined ? undefined : { optionId: `opt-${options.status}`, name: options.status } });
    return issue;
  }

  /** Seed one existing comment, used to prove marker-keyed idempotency. */
  seedComment(number: number, body: string, id = 900): BacklogComment {
    const comment: BacklogComment = { id, nodeId: `COMMENTNODE_${id}`, url: `${URL_BASE}/${number}#issuecomment-${id}`, body, author: "author", createdAt: "2026-10-16T00:00:00.000Z" };
    this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
    return comment;
  }

  commentsFor(number: number): readonly BacklogComment[] {
    return this.comments.get(number) ?? [];
  }

  statusOf(issueNodeId: string): string | undefined {
    return this.items.get(issueNodeId)?.status?.name;
  }

  writeOperations(): string[] {
    return this.writes.map((write) => write.operation);
  }

  async validateRepository(): Promise<{ private: boolean; fullName: string }> {
    this.reads.push("validateRepository");
    if (this.behaviour.repositoryForbidden === true) {
      throw new BacklogConfigurationError("Backlog token cannot authorize reading backlog repository at GET https://api.github.com/repos/acme/backlog (HTTP 403). FORGE_BACKLOG_TOKEN needs the classic `repo` scope for private issues and the `project` scope for the Project.");
    }
    return { private: this.behaviour.repositoryPrivate ?? true, fullName: this.behaviour.repositoryFullName ?? this.repository };
  }

  async validateProject(requiredStatuses: readonly string[]): Promise<BacklogStatusField> {
    this.reads.push("validateProject");
    if (this.behaviour.projectForbidden === true) {
      throw new BacklogConfigurationError("Backlog token cannot authorize reading backlog Project at https://api.github.com/graphql (HTTP 403). Projects v2 requires a classic PAT with the `project` scope; fine-grained PATs cannot access it. Bearer backlog_secret_xyz");
    }
    if (this.behaviour.projectPublic === true) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} is public; the backlog must be a private Project.`);
    }
    if (this.behaviour.projectStatusField === false) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} has no single-select \`Status\` field, so issue status cannot be read or set.`);
    }
    const options = (this.behaviour.projectStatuses ?? FAKE_STATUSES).map((name) => ({ optionId: `opt-${name}`, name }));
    const missing = requiredStatuses.filter((required) => !options.some((option) => option.name === required));
    if (missing.length > 0) {
      throw new BacklogConfigurationError(`Backlog Project ${this.projectId} \`Status\` field is missing required options: ${missing.join(", ")}.`);
    }
    return { fieldId: "FIELD_status", fieldName: "Status", options };
  }

  async listIssues(): Promise<readonly BacklogIssue[]> {
    this.reads.push("listIssues");
    return [...this.issues];
  }

  async getIssue(number: number): Promise<BacklogIssue | undefined> {
    this.reads.push(`getIssue:${number}`);
    return this.issues.find((issue) => issue.number === number);
  }

  /** Mirrors the transport's fail-closed write gate: a public repository, a public Project, or a Project the token cannot update refuses every write before it is recorded. */
  private requirePrivateBacklog(operation: string): void {
    if (this.behaviour.repositoryPrivate === false) {
      throw new BacklogConfigurationError(`Refusing ${operation}: backlog repository ${this.repository} is public, so ticket content would be published.`);
    }
    if (this.behaviour.projectPublic === true) {
      throw new BacklogConfigurationError(`Refusing ${operation}: backlog Project ${this.projectId} is public, so ticket content would be published.`);
    }
    if (this.behaviour.projectReadOnly === true) {
      throw new BacklogConfigurationError(`Refusing ${operation}: backlog Project ${this.projectId} is not updatable with the configured backlog token.`);
    }
  }

  async createIssue(title: string, body: string): Promise<{ number: number; nodeId: string; url: string }> {
    this.requirePrivateBacklog("creating a backlog issue");
    this.writes.push({ operation: "createIssue", body });
    const number = this.nextNumber++;
    const issue: FakeIssue = { number, nodeId: `ISSIONODE_${number}`, url: `${URL_BASE}/${number}`, title, body, state: "open", stateReason: undefined, revision: `rev-${number}`, author: "author" };
    this.issues.push(issue);
    return { number, nodeId: issue.nodeId, url: issue.url };
  }

  async updateIssueBody(number: number, body: string, expectedRevision: string): Promise<BacklogIssue> {
    this.requirePrivateBacklog("updating a backlog issue body");
    const issue = this.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) throw new BacklogConfigurationError(`Backlog issue ${number} no longer exists, so its body cannot be updated.`);
    this.behaviour.externalEditBeforeUpdate?.(issue);
    if (issue.revision !== expectedRevision) {
      throw new BacklogConflictError(`Backlog issue ${number} changed externally before the update: expected revision ${expectedRevision}, found ${issue.revision}. No update was sent.`);
    }
    this.writes.push({ operation: "updateIssueBody", issueNumber: number, body });
    const index = this.issues.indexOf(issue);
    this.issues[index] = { ...issue, body, revision: `${issue.revision}+1` };
    return this.issues[index]!;
  }

  async createComment(number: number, body: string): Promise<NewComment> {
    this.requirePrivateBacklog("commenting on backlog issue");
    this.writes.push({ operation: "createComment", issueNumber: number, body });
    if (this.behaviour.commentFailure !== undefined) {
      throw new BacklogHttpError({ operation: "commenting on backlog issue", command: `POST ${URL_BASE}/${number}/comments`, status: 500, stdout: this.behaviour.commentFailure, stderr: `HTTP 500 ${this.behaviour.commentFailure}` }, new Error(this.behaviour.commentFailure));
    }
    const id = 500 + this.writes.length;
    const comment: BacklogComment = { id, nodeId: `COMMENTNODE_${id}`, url: `${URL_BASE}/${number}#issuecomment-${id}`, body, author: "author", createdAt: "2026-10-16T10:00:00.000Z" };
    this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
    return { id, url: comment.url };
  }

  async listComments(number: number): Promise<readonly BacklogComment[]> {
    this.reads.push(`listComments:${number}`);
    return this.commentsFor(number);
  }

  async closeIssueCompleted(number: number): Promise<void> {
    this.requirePrivateBacklog("closing a backlog issue");
  }

  /** The runner's bulk Project walk (Step 5/6). Submission resolves one Project item per issue, so a call here is a regression, not a behaviour to model. */
  async listProjectItems(): Promise<readonly BacklogProjectEntry[]> {
    throw new Error("Submission must resolve one Project item per issue, never walk the whole Project.");
  }

  async findProjectItem(issueNodeId: string): Promise<BacklogProjectItem | undefined> {
    this.reads.push(`findProjectItem:${issueNodeId}`);
    return this.items.get(issueNodeId);
  }

  async setProjectStatus(issueNodeId: string, optionId: string): Promise<void> {
    this.requirePrivateBacklog("setting a backlog Project status");
    this.writes.push({ operation: "setProjectStatus", optionId });
    this.statusWrites.push(optionId);
    const existing = this.items.get(issueNodeId);
    this.items.set(issueNodeId, { itemId: existing?.itemId ?? `ITEM_${issueNodeId}`, status: { optionId, name: optionId.replace(/^opt-/, "") } });
  }
}
