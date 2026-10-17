import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BacklogWorkflow, issueSubject, type BacklogTarget, type ReviewPublication } from "./backlog-workflow.js";
import { PublicationLedger } from "./publication-ledger.js";
import { commentMarker, operationKey } from "./publication-record.js";
import { AuthorizationWithdrawnError, type IssueAuthorization } from "./authorization-guard.js";
import type {
  BacklogComment,
  BacklogIssue,
  BacklogProjectEntry,
  BacklogProjectItem,
  BacklogStatusField,
  GitHubBacklog,
  NewComment,
} from "../../infrastructure/github-backlog/index.js";

const STATUS_NAMES = ["Backlog", "Ready", "In progress", "In review", "Done", "Blocked"];

class FakeBacklog implements GitHubBacklog {
  readonly repository = "acme/backlog";
  readonly projectId = "PVT_1";
  readonly secrets = ["ghp_backlog"];
  readonly comments = new Map<number, BacklogComment[]>();
  readonly statuses = new Map<string, string>();
  readonly closed: number[] = [];
  readonly writes: string[] = [];
  requirementsHash = "a".repeat(64);
  readonly validations: string[] = [];
  statusField: BacklogStatusField = {
    fieldId: "PVTSSF_1",
    fieldName: "Status",
    options: STATUS_NAMES.map((name, index) => ({ optionId: `option-${index}`, name })),
  };
  /** When set to an issue node id, the read-back after a status write keeps reporting Backlog. */
  stubborn: string | undefined;

  async validateRepository(): Promise<{ private: boolean; fullName: string }> {
    return { private: true, fullName: this.repository };
  }

  async validateProject(requiredStatuses: readonly string[]): Promise<BacklogStatusField> {
    this.validations.push(requiredStatuses.join(","));
    const missing = requiredStatuses.filter((name) => !this.statusField.options.some((option) => option.name === name));
    if (missing.length > 0) throw new Error(`Project status options missing: ${missing.join(", ")}`);
    return this.statusField;
  }

  async listIssues(): Promise<readonly BacklogIssue[]> {
    return [];
  }

  async getIssue(number: number): Promise<BacklogIssue | undefined> {
    if (number !== 7 && !this.closed.includes(number)) return undefined;
    return {
      number,
      nodeId: "NODE_ticket-a",
      url: `https://github.com/acme/backlog/issues/${number}`,
      title: "Fix login",
      body: this.requirementsHash,
      state: this.closed.includes(number) ? "closed" : "open",
      stateReason: "completed",
      revision: "2026-10-11T07:00:00.000Z",
      author: "author",
    };
  }

  async createIssue(): Promise<{ number: number; nodeId: string; url: string }> {
    throw new Error("the settlement workflow never creates issues");
  }

  async updateIssueBody(): Promise<BacklogIssue> {
    throw new Error("the settlement workflow never rewrites issue bodies");
  }

  async createComment(number: number, body: string): Promise<NewComment> {
    this.writes.push(`comment:${number}`);
    const id = 1000 + this.writes.length;
    const list = this.comments.get(number) ?? [];
    list.push({ id, nodeId: `VCV_${id}`, url: `https://github.com/acme/backlog/issues/${number}#issuecomment-${id}`, body, author: "factory", createdAt: "2026-10-11T07:00:00.000Z" });
    this.comments.set(number, list);
    return { id, url: `https://github.com/acme/backlog/issues/${number}#issuecomment-${id}` };
  }

  async listComments(number: number): Promise<readonly BacklogComment[]> {
    return this.comments.get(number) ?? [];
  }

  async closeIssueCompleted(number: number): Promise<void> {
    this.writes.push("close");
    this.closed.push(number);
  }

  async findProjectItem(issueNodeId: string): Promise<BacklogProjectItem | undefined> {
    const name = this.statuses.get(issueNodeId);
    if (name === undefined) return undefined;
    return { itemId: "PVTI_1", status: this.statusField.options.find((option) => option.name === name) };
  }

  async listProjectItems(): Promise<readonly BacklogProjectEntry[]> {
    return [];
  }

  async setProjectStatus(issueNodeId: string, optionId: string): Promise<void> {
    this.writes.push(`status:${optionId}`);
    const option = this.statusField.options.find((candidate) => candidate.optionId === optionId);
    if (option === undefined) throw new Error(`unknown option ${optionId}`);
    this.statuses.set(issueNodeId, this.stubborn === issueNodeId ? "Backlog" : option.name);
  }
}

function target(ticketId = "ticket-a", number = 7): BacklogTarget {
  return {
    identity: { backlogRepository: "acme/backlog", number, nodeId: `NODE_${ticketId}`, url: `https://github.com/acme/backlog/issues/${number}` },
    ticketId,
    requirementsHash: "a".repeat(64),
    title: "Fix login",
  };
}

const publication: ReviewPublication = {
  number: 123,
  url: "https://github.com/acme/app/pull/123",
  head: "factory/ticket-a",
  sourceSha: "1".repeat(40),
  mergeStrategy: "squash",
  squashPreference: "unsupported",
  title: "Factory: Fix login",
};

async function openWorkflow(): Promise<{ backlog: FakeBacklog; workflow: BacklogWorkflow; ledger: PublicationLedger }> {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-workflow-"));
  const backlog = new FakeBacklog();
  const ledger = PublicationLedger.open(root);
  backlog.statuses.set("NODE_ticket-a", "Ready");
  const workflow = new BacklogWorkflow(
    backlog,
    ledger,
    (text) => text.split("ghp_backlog").join("<redacted>"),
    () => new Date("2026-10-11T07:00:00.000Z"),
    async (identity): Promise<IssueAuthorization> => {
      const issue = await backlog.getIssue(identity.number);
      const item = await backlog.findProjectItem(identity.nodeId);
      return { open: issue?.state === "open", status: item?.status?.name as IssueAuthorization["status"], requirementsHash: issue?.body };
    },
  );
  await workflow.validate();
  backlog.writes.length = 0;
  return { backlog, workflow, ledger };
}

function bodies(backlog: FakeBacklog, number = 7): string[] {
  return (backlog.comments.get(number) ?? []).map((comment) => comment.body);
}

test("validating the workflow requires every configured status name from the Project", async () => {
  const { backlog } = await openWorkflow();
  assert.deepEqual(backlog.validations, [STATUS_NAMES.join(",")]);
});

test("claiming posts one keyed start comment and then the In progress transition", async () => {
  const { backlog, workflow } = await openWorkflow();
  await workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main");

  assert.deepEqual(backlog.writes, ["comment:7", "status:option-2"]);
  const [comment] = bodies(backlog);
  assert.ok(comment!.includes(commentMarker("factory:start:issue-7:1a2b3c")), comment);
  assert.match(comment!, /- Ticket: `ticket-a`/);
  assert.match(comment!, /- Work branch: `factory\/ticket-a`/);
  assert.match(comment!, /- Requirements: `a{64}`/);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "In progress");
});

test("a repeated claim repeats neither the comment nor the status write", async () => {
  const { backlog, workflow } = await openWorkflow();
  await workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main");
  backlog.writes.length = 0;
  await workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main");
  assert.deepEqual(backlog.writes, []);
});

for (const status of ["Backlog", "Blocked", "In review", "Done", undefined]) {
  test(`a stale claim cannot overwrite a human's ${status ?? "missing"} status`, async () => {
    const { backlog, workflow, ledger } = await openWorkflow();
    if (status === undefined) backlog.statuses.delete("NODE_ticket-a");
    else backlog.statuses.set("NODE_ticket-a", status);
    await assert.rejects(workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main"), AuthorizationWithdrawnError);
    assert.deepEqual(backlog.writes, []);
    assert.equal(backlog.statuses.get("NODE_ticket-a"), status);
    assert.deepEqual((await ledger.load()).settlements, []);
  });
}

test("closed issues and changed requirements cannot be claimed", async () => {
  for (const change of ["closed", "requirements"]) {
    const { backlog, workflow } = await openWorkflow();
    if (change === "closed") backlog.closed.push(7);
    else backlog.requirementsHash = "b".repeat(64);
    await assert.rejects(workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main"), AuthorizationWithdrawnError);
    assert.deepEqual(backlog.writes, []);
    assert.equal(backlog.statuses.get("NODE_ticket-a"), "Ready");
  }
});

test("withdrawal during the start comment is not overwritten by a claim transition", async () => {
  const { backlog, workflow, ledger } = await openWorkflow();
  const createComment = backlog.createComment.bind(backlog);
  backlog.createComment = async (number, body) => {
    const comment = await createComment(number, body);
    backlog.statuses.set("NODE_ticket-a", "Blocked");
    return comment;
  };
  await assert.rejects(workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main"), AuthorizationWithdrawnError);
  assert.deepEqual(backlog.writes, ["comment:7"]);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Blocked");
  assert.deepEqual((await ledger.load()).settlements, []);
});

test("claiming without an authoritative reader fails closed", async () => {
  const { backlog, ledger } = await openWorkflow();
  const workflow = new BacklogWorkflow(backlog, ledger);
  await assert.rejects(workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main"), AuthorizationWithdrawnError);
  assert.deepEqual(backlog.writes, []);
});

test("withdrawal while checking comment idempotency prevents the start comment", async () => {
  const { backlog, workflow } = await openWorkflow();
  const listComments = backlog.listComments.bind(backlog);
  backlog.listComments = async (number) => {
    backlog.statuses.set("NODE_ticket-a", "Backlog");
    return listComments(number);
  };
  await assert.rejects(workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main"), AuthorizationWithdrawnError);
  assert.deepEqual(backlog.writes, []);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Backlog");
});

test("withdrawal during durable claim recording leaves no status write to replay", async () => {
  const { backlog, workflow, ledger } = await openWorkflow();
  const recordSettlement = ledger.recordSettlement.bind(ledger);
  ledger.recordSettlement = async (record) => {
    await recordSettlement(record);
    backlog.statuses.set("NODE_ticket-a", "Blocked");
  };
  await assert.rejects(workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main"), AuthorizationWithdrawnError);
  assert.deepEqual(backlog.writes, ["comment:7"]);
  assert.deepEqual((await ledger.load()).settlements, []);
  await workflow.recover();
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Blocked");
});

test("a blocked ticket gets a redacted keyed reason and the Blocked status", async () => {
  const { backlog, workflow } = await openWorkflow();
  await workflow.blocked(target(), "agent runtime failed with token ghp_backlog", "1a2b3c");
  const [comment] = bodies(backlog);
  assert.ok(comment!.includes(commentMarker("factory:failure:issue-7:1a2b3c")), comment);
  assert.ok(!comment!.includes("ghp_backlog"), "the credential reached the issue");
  assert.match(comment!, /<redacted>/);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Blocked");
});

test("the same blocking reason never posts a second comment", async () => {
  const { backlog, workflow } = await openWorkflow();
  await workflow.blocked(target(), "implementation exhausted 3 attempts", "cycle-2");
  backlog.writes.length = 0;
  await workflow.blocked(target(), "implementation exhausted 3 attempts", "cycle-2");
  assert.deepEqual(backlog.writes, []);
});

test("review settlement posts publication facts and moves every included ticket", async () => {
  const { backlog, workflow } = await openWorkflow();
  await workflow.inReview([target("ticket-a", 7), target("ticket-b", 8)], publication, "group-1");

  assert.equal(backlog.statuses.get("NODE_ticket-a"), "In review");
  assert.equal(backlog.statuses.get("NODE_ticket-b"), "In review");
  const [first] = bodies(backlog, 7);
  const [second] = bodies(backlog, 8);
  assert.ok(first!.includes(commentMarker("factory:publication:issue-7:https-github.com-acme-app-pull-123")), first);
  assert.ok(second!.includes(commentMarker("factory:publication:issue-8:https-github.com-acme-app-pull-123")), second);
  assert.match(first!, /- Pull request: #123 https:\/\/github\.com\/acme\/app\/pull\/123/);
  assert.match(first!, /- Source commit: `1{40}`/);
  assert.match(first!, /Requested merge method: squash \(unsupported\)/);
});

test("completion records the merge, sets Done, and closes the issue once", async () => {
  const { backlog, workflow, ledger } = await openWorkflow();
  await workflow.done(target(), "pr-123", { pullRequestUrl: publication.url, mergeCommitSha: "2".repeat(40) });

  assert.deepEqual(backlog.writes, ["comment:7", "status:option-4", "close"]);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Done");
  assert.deepEqual(backlog.closed, [7]);
  assert.match(bodies(backlog)[0]!, /- Merge commit: `2{40}`/);
  assert.deepEqual((await ledger.load()).settlements, []);
});

test("a status write the Project did not apply keeps a durable record and fails", async () => {
  const { backlog, workflow, ledger } = await openWorkflow();
  backlog.stubborn = "NODE_ticket-a";
  await assert.rejects(() => workflow.blocked(target(), "reason", "1a2b3c"), /did not apply `Blocked`/);

  const snapshot = await ledger.load();
  assert.equal(snapshot.settlements.length, 1);
  assert.equal(snapshot.settlements[0]!.kind, "status");
  assert.equal(snapshot.settlements[0]!.status, "Blocked");
  assert.equal(snapshot.settlements[0]!.subject, issueSubject(target().identity));
});

test("recovery replays the recorded status and closure effects, then clears them", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-recovery-"));
  const backlog = new FakeBacklog();
  const ledger = PublicationLedger.open(root);
  await ledger.recordSettlement({
    version: 1, operationKey: "factory:settlement:issue-7:status-in-review", kind: "status", subject: "issue-7", status: "In review",
    ticketId: "ticket-a", issueNumber: 7, issueNodeId: "NODE_ticket-a", detail: "pull-request-123", recordedAt: "2026-10-11T07:00:00.000Z",
  });
  await ledger.recordSettlement({
    version: 1, operationKey: "factory:settlement:issue-7:close-2222222222222222222222222222222222222222", kind: "close", subject: "issue-7",
    ticketId: "ticket-a", issueNumber: 7, issueNodeId: "NODE_ticket-a", detail: "2".repeat(40), recordedAt: "2026-10-11T07:00:00.000Z",
  });
  const workflow = new BacklogWorkflow(backlog, ledger);

  const recovered = await workflow.recover();

  assert.equal(backlog.statuses.get("NODE_ticket-a"), "In review");
  assert.deepEqual(backlog.closed, [7]);
  assert.deepEqual(recovered.map((entry) => entry.detail), ["2".repeat(40), "pull-request-123"]);
  assert.deepEqual((await ledger.load()).settlements, []);
});

test("preservation names the preserved branch and commit and parks the ticket", async () => {
  const { backlog, workflow } = await openWorkflow();
  await workflow.preserved(target(), "1a2b3c", {
    attemptId: "1a2b3c",
    branch: "factory/ticket-a",
    commitSha: "3".repeat(40),
    repository: "git@github.com:acme/app.git",
    baseBranch: "main",
    workspacePath: "/runner/.workspaces/ticket-a-1a2b3c",
    branchUrl: "https://github.com/acme/app/tree/factory/ticket-a",
    pushed: true,
    pushFailure: undefined,
    captureComplete: true,
    captureFailure: undefined,
    reviewed: false,
  });

  assert.deepEqual(backlog.writes, ["comment:7", "status:option-5"]);
  const [comment] = bodies(backlog);
  assert.ok(comment!.includes(commentMarker("factory:preservation:issue-7:1a2b3c")), comment);
  assert.match(comment!, /- Branch: `factory\/ticket-a`/);
  assert.match(comment!, /- Branch link: https:\/\/github\.com\/acme\/app\/tree\/factory\/ticket-a/);
  assert.match(comment!, /- Commit: `3{40}`/);
  assert.match(comment!, /- Workspace: `\/runner\/\.workspaces\/ticket-a-1a2b3c`/);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Blocked");
});

test("withdrawal reports incomplete work capture without replacing the human's status", async () => {
  const { backlog, workflow } = await openWorkflow();
  backlog.statuses.set("NODE_ticket-a", "Backlog");
  await workflow.withdrawn(target(), "1a2b3c", {
    attemptId: "1a2b3c",
    branch: "factory/ticket-a",
    commitSha: "3".repeat(40),
    repository: "git@github.com:acme/app.git",
    baseBranch: "main",
    workspacePath: "/runner/workspace",
    branchUrl: undefined,
    pushed: true,
    pushFailure: undefined,
    captureComplete: false,
    captureFailure: "Unresolved merge conflicts",
    reviewed: false,
    stage: "review",
  });
  assert.deepEqual(backlog.writes, ["comment:7"]);
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Backlog");
  assert.match(bodies(backlog)[0]!, /Work capture: incomplete.*Unresolved merge conflicts/);
});

test("retiring a publication returns the issue to Ready", async () => {
  const { backlog, workflow } = await openWorkflow();
  backlog.statuses.set("NODE_ticket-a", "In review");
  await workflow.resume(target(), "retired-publication");
  assert.equal(backlog.statuses.get("NODE_ticket-a"), "Ready");
});

test("a Project missing a configured status option fails validation by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-nostatus-"));
  const backlog = new FakeBacklog();
  backlog.statusField = { ...backlog.statusField, options: backlog.statusField.options.filter((option) => option.name !== "Blocked") };
  const workflow = new BacklogWorkflow(backlog, PublicationLedger.open(root));

  await assert.rejects(() => workflow.validate(), /status options missing: Blocked/);
  assert.deepEqual(backlog.writes, []);
});

test("a public backlog repository is refused before any effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "sandcastle-public-"));
  class PublicBacklog extends FakeBacklog {
    override async validateRepository(): Promise<{ private: boolean; fullName: string }> {
      return { private: false, fullName: this.repository };
    }
  }
  const backlog = new PublicBacklog();
  const workflow = new BacklogWorkflow(backlog, PublicationLedger.open(root));

  await assert.rejects(() => workflow.validate(), /acme\/backlog is not private/);
  assert.deepEqual(backlog.writes, []);
  await assert.rejects(() => readdir(join(root, ".factory-state")), { code: "ENOENT" });
});

// ---------------------------------------------------------------------------
// settlement records for effects already in effect
// ---------------------------------------------------------------------------

test("a settlement record is consumed when its effect is already in effect", async () => {
  const { backlog, workflow, ledger } = await openWorkflow();
  // An earlier process crashed after the board write, leaving the record.
  await ledger.recordSettlement({
    version: 1,
    operationKey: operationKey("settlement", issueSubject(target().identity), "status-in-progress"),
    kind: "status",
    subject: issueSubject(target().identity),
    status: "In progress",
    ticketId: "ticket-a",
    issueNumber: 7,
    issueNodeId: "NODE_ticket-a",
    detail: "In progress",
    recordedAt: new Date().toISOString(),
  });
  backlog.statuses.set("NODE_ticket-a", "In progress");

  await workflow.claim(target(), "1a2b3c", "factory/ticket-a", "git@github.com:acme/app.git", "main");

  assert.deepEqual((await ledger.load()).settlements, [], "replaying an effect already in effect completes its record");
  assert.deepEqual(backlog.writes, ["comment:7"], "the board status is not written twice");
});
