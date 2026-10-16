// Raw backlog data for the private GitHub transport: issue, comment, and Project-status records
// exactly as GitHub reports them. Workflow policy (which status follows which outcome) belongs to
// the features that schedule work, never to this module.

/** One backlog issue. `revision` is the issue `updated_at` used to detect an external edit before a write. */
export type BacklogIssue = Readonly<{
  number: number;
  nodeId: string;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  stateReason: string | undefined;
  revision: string;
  author: string | undefined;
}>;

/** One single-select option of the Project Status field. */
export type BacklogStatusOption = Readonly<{
  optionId: string;
  name: string;
}>;

/** The Project's Status field with every configured option, in board order. */
export type BacklogStatusField = Readonly<{
  fieldId: string;
  fieldName: string;
  options: readonly BacklogStatusOption[];
}>;

/** One Project item and its current Status value; an item with no status set reports `status: undefined`. */
export type BacklogProjectItem = Readonly<{
  itemId: string;
  status: BacklogStatusOption | undefined;
}>;

/** One Project item with the issue it represents and its current Status value. */
export type BacklogProjectEntry = Readonly<{
  issueNodeId: string;
  issueNumber: number;
  itemId: string;
  status: BacklogStatusOption | undefined;
}>;

/** One issue comment. */
export type BacklogComment = Readonly<{
  id: number;
  nodeId: string;
  url: string;
  body: string;
  author: string | undefined;
  createdAt: string;
}>;

/** The identity returned for a newly created comment. */
export type NewComment = Readonly<{
  id: number;
  url: string;
}>;

/** Mechanical backlog transport: reads, gated writes, and Project item/status operations. */
export interface GitHubBacklog {
  /** Configured `owner/repository` backlog. */
  readonly repository: string;
  /** Configured Project v2 node id. */
  readonly projectId: string;
  /** Raw token; every value that must never reach a log, comment, or command display. */
  readonly secrets: readonly string[];

  validateRepository(): Promise<{ private: boolean; fullName: string }>;
  validateProject(requiredStatuses: readonly string[]): Promise<BacklogStatusField>;
  listIssues(): Promise<readonly BacklogIssue[]>;
  getIssue(number: number): Promise<BacklogIssue | undefined>;
  createIssue(title: string, body: string): Promise<{ number: number; nodeId: string; url: string }>;
  updateIssueBody(number: number, body: string, expectedRevision: string): Promise<BacklogIssue>;
  createComment(number: number, body: string): Promise<NewComment>;
  listComments(number: number): Promise<readonly BacklogComment[]>;
  closeIssueCompleted(number: number): Promise<void>;
  findProjectItem(issueNodeId: string): Promise<BacklogProjectItem | undefined>;
  listProjectItems(): Promise<readonly BacklogProjectEntry[]>;
  setProjectStatus(issueNodeId: string, optionId: string): Promise<void>;
}
