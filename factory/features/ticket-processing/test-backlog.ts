import type {
  BacklogComment,
  BacklogIssue,
  BacklogProjectEntry,
  BacklogProjectItem,
  BacklogStatusField,
  GitHubBacklog,
  NewComment,
} from "../../infrastructure/github-backlog/index.js";
import { commentMarker } from "./publication-record.js";

/**
 * In-memory backlog for the coordinator: authored issues plus their Project board entries, which is
 * everything the runner reads and writes. `listProjectItems` answers in board order, unlike the
 * submission fake, because discovery needs the whole board in one read.
 */

/** The repository the ticket sources target; a fixture `ssh` serves it from a local bare repository. */
export const TEST_REPOSITORY = "git@github.com:acme/app.git";
/** A second hosted target, so routing an Azure DevOps ticket through its adapter is exercised. */
export const TEST_ADO_REPOSITORY = "git@ssh.dev.azure.com:v3/acme/project/repo";
export const TEST_GITHUB_TOKEN = "ghp_fixture_token_1234567890abcdef";
export const TEST_AZURE_DEVOPS_PAT = "fixture-azure-devops-pat-0123456789";
export const TEST_BACKLOG_TOKEN = "fixture-backlog-token-98765";

export const TEST_STATUS_NAMES = ["Backlog", "Ready", "In progress", "In review", "Done", "Blocked"] as const;
export const testStatusOptionId = (name: string) => `option-${name.toLowerCase().replaceAll(" ", "-")}`;

/** One authored issue with its board position. */
export type TestSeed = Readonly<{ id: string; number: number; status: string; dependencies?: readonly string[]; repository?: string; body?: string }>;

export class TestBacklog implements GitHubBacklog {
  readonly repository = "acme/tickets";
  readonly projectId = "PVT_fixture_1";
  readonly secrets: readonly string[] = [TEST_BACKLOG_TOKEN];

  readonly issues: BacklogIssue[] = [];
  readonly comments = new Map<number, BacklogComment[]>();
  readonly writes: string[] = [];
  readonly closed: number[] = [];
  /** Every Project status write in board order, as `<ticket id>=<status>`. */
  readonly transitions: string[] = [];
  private readonly statuses = new Map<string, string>();
  private readonly numbers = new Map<string, number>();

  /** Author one issue and place its board entry; the runner never authors issues itself. */
  seed(entry: TestSeed): BacklogIssue {
    const body =
      entry.body ??
      [
        "---",
        `id: ${entry.id}`,
        `name: ${entry.id}`,
        `repository: ${entry.repository ?? TEST_REPOSITORY}`,
        "baseBranch: main",
        ...(entry.dependencies === undefined || entry.dependencies.length === 0
          ? []
          : [`dependsOnTickets: [${entry.dependencies.join(", ")}]`]),
        "---",
        `# ${entry.id}`,
        "",
        `Implement ${entry.id}.`,
      ].join("\n");
    const issue: BacklogIssue = {
      number: entry.number,
      nodeId: `I_NODE_${entry.id}`,
      url: `https://github.com/acme/tickets/issues/${entry.number}`,
      title: entry.id,
      body,
      state: "open",
      stateReason: undefined,
      revision: "2026-10-16T07:00:00.000Z",
      author: "author",
    };
    this.issues.push(issue);
    this.statuses.set(issue.nodeId, entry.status);
    this.numbers.set(entry.id, entry.number);
    return issue;
  }

  issueNumber(ticketId: string): number {
    return this.numbers.get(ticketId)!;
  }

  statusOf(ticketId: string): string | undefined {
    return this.statuses.get(`I_NODE_${ticketId}`);
  }

  /** An operator moves an issue between Project columns between cycles. */
  moveTo(ticketId: string, status: string): void {
    this.statuses.set(`I_NODE_${ticketId}`, status);
  }

  /** An operator removes an issue from the board, leaving it open with no Status value. */
  unboard(ticketId: string): void {
    this.statuses.delete(`I_NODE_${ticketId}`);
  }

  /** Rewrite an authored body, which is how an author takes a requirement back. */
  rewrite(ticketId: string, body: string): void {
    const index = this.issues.findIndex((issue) => issue.number === this.issueNumber(ticketId));
    this.issues[index] = { ...this.issues[index]!, body };
  }

  bodies(ticketId: string): string[] {
    return (this.comments.get(this.issueNumber(ticketId)) ?? []).map((comment) => comment.body);
  }

  /** Every comment on one issue carrying one operation key's marker. */
  bodiesWith(ticketId: string, key: string): string[] {
    return this.bodies(ticketId).filter((body) => body.includes(commentMarker(key)));
  }

  /** Comments on one issue that carry any `factory:` marker. */
  markerBodies(ticketId: string): string[] {
    return this.bodies(ticketId).filter((body) => body.includes("<!-- factory:"));
  }

  async validateRepository(): Promise<{ private: boolean; fullName: string }> {
    return { private: true, fullName: this.repository };
  }

  async validateProject(): Promise<BacklogStatusField> {
    return { fieldId: "PVTSSF_fixture", fieldName: "Status", options: TEST_STATUS_NAMES.map((name) => ({ optionId: testStatusOptionId(name), name })) };
  }

  async listIssues(): Promise<readonly BacklogIssue[]> {
    return [...this.issues];
  }

  async getIssue(number: number): Promise<BacklogIssue | undefined> {
    return this.issues.find((issue) => issue.number === number);
  }

  async createIssue(): Promise<{ number: number; nodeId: string; url: string }> {
    throw new Error("the coordinator never authors issues");
  }

  async updateIssueBody(): Promise<BacklogIssue> {
    throw new Error("the coordinator never rewrites an authored issue body");
  }

  async createComment(number: number, body: string): Promise<NewComment> {
    this.writes.push(`comment:${number}`);
    const id = 1000 + this.writes.length;
    const comment: BacklogComment = {
      id,
      nodeId: `VCV_${id}`,
      url: `https://github.com/acme/tickets/issues/${number}#issuecomment-${id}`,
      body,
      author: "factory",
      createdAt: "2026-10-16T07:00:00.000Z",
    };
    this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
    return { id, url: comment.url };
  }

  async listComments(number: number): Promise<readonly BacklogComment[]> {
    return this.comments.get(number) ?? [];
  }

  async closeIssueCompleted(number: number): Promise<void> {
    this.writes.push("close");
    this.closed.push(number);
    const index = this.issues.findIndex((issue) => issue.number === number);
    if (index >= 0) this.issues[index] = { ...this.issues[index]!, state: "closed", stateReason: "completed" };
  }

  async findProjectItem(issueNodeId: string): Promise<BacklogProjectItem | undefined> {
    const name = this.statuses.get(issueNodeId);
    if (name === undefined) return undefined;
    return { itemId: `PVTI_${issueNodeId}`, status: { optionId: testStatusOptionId(name), name } };
  }

  async listProjectItems(): Promise<readonly BacklogProjectEntry[]> {
    return this.issues.map((issue) => {
      const name = this.statuses.get(issue.nodeId);
      return {
        issueNodeId: issue.nodeId,
        issueNumber: issue.number,
        itemId: `PVTI_${issue.nodeId}`,
        status: name === undefined ? undefined : { optionId: testStatusOptionId(name), name },
      };
    });
  }

  async setProjectStatus(issueNodeId: string, requested: string): Promise<void> {
    this.writes.push(`status:${issueNodeId}`);
    const name = TEST_STATUS_NAMES.find((candidate) => testStatusOptionId(candidate) === requested);
    if (name === undefined) throw new Error(`unknown Project status option ${requested}`);
    this.statuses.set(issueNodeId, name);
    this.transitions.push(`${issueNodeId.slice("I_NODE_".length)}=${name}`);
  }
}
