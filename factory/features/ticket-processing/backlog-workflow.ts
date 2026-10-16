import type { BacklogStatusOption, GitHubBacklog } from "../../infrastructure/github-backlog/index.js";
import { BacklogConfigurationError } from "../../infrastructure/github-backlog/index.js";
import { commentMarker, operationKey } from "./publication-record.js";
import { PublicationLedger, type PendingSettlement } from "./publication-ledger.js";
import { BACKLOG_STATUSES, type BacklogStatusName, type IssueIdentity } from "../tickets/index.js";

// Backlog settlement (D11): every issue effect is one idempotent operation built from a stable
// operation key, and every status transition is durably recorded, applied, read back, and only then
// completed. Comments carry the key marker so a restart can prove an effect already happened;
// statuses and closures are verified by provider read-back.

/** One issue the runner settles, with the ticket identity its comments must name. */
export type BacklogTarget = Readonly<{
  identity: IssueIdentity;
  ticketId: string;
  requirementsHash: string;
  title: string;
}>;

/** Published pull-request facts recorded on every included issue. */
export type ReviewPublication = Readonly<{
  number: number;
  url: string;
  head: string;
  sourceSha: string;
  mergeStrategy: "squash";
  squashPreference: "configured" | "unsupported";
  title: string;
}>;

/** Work preserved on its remote branch after authorization was withdrawn. */
export type PreservationFacts = Readonly<{
  attemptId: string;
  branch: string;
  commitSha: string;
  repository: string;
  baseBranch: string;
  workspacePath: string;
  branchUrl: string | undefined;
  pushed: boolean;
  pushFailure: string | undefined;
  reviewed: boolean;
}>;

/** One durable settlement replayed at startup. */
export type RecoveredSettlement = Readonly<{ ticketId: string; issueNumber: number; detail: string }>;

/** The key-safe subject for one issue; one backlog per invocation makes its number unique. */
export function issueSubject(identity: IssueIdentity): string {
  return `issue-${identity.number}`;
}

function codeOf(status: BacklogStatusName): string {
  return status.toLowerCase().replaceAll(" ", "-");
}

function quoted(value: string): string {
  return `\`${value}\``;
}

export class BacklogWorkflow {
  private readonly backlog: GitHubBacklog;
  private readonly ledger: PublicationLedger;
  private readonly redact: (text: string) => string;
  private readonly now: () => Date;
  private options: ReadonlyMap<string, BacklogStatusOption> | undefined;

  constructor(backlog: GitHubBacklog, ledger: PublicationLedger, redact: (text: string) => string = (text) => text, now: () => Date = () => new Date()) {
    this.backlog = backlog;
    this.ledger = ledger;
    this.redact = redact;
    this.now = now;
  }

  /** Startup gate: the backlog is private and the Project exposes every configured status. */
  async validate(): Promise<void> {
    const repository = await this.backlog.validateRepository();
    if (!repository.private) {
      throw new BacklogConfigurationError(`backlog repository ${repository.fullName} is not private; the runner refuses a public backlog`);
    }
    this.options = await this.statusOptions();
  }

  /** Move an authored issue out of Staging and into the queue. */
  async stage(target: BacklogTarget): Promise<void> {
    await this.setStatus(target, "Ready for development");
  }

  /** Claim a ticket for one attempt: durable start comment, then `In progress`. */
  async claim(target: BacklogTarget, attemptId: string, branch: string, repository: string, baseBranch: string): Promise<void> {
    await this.post(target.identity, "start", attemptId, [
      "## Factory attempt started",
      "",
      `- Ticket: ${quoted(target.ticketId)}`,
      `- Requirements: ${quoted(target.requirementsHash)}`,
      `- Target repository: ${quoted(repository)}`,
      `- Base branch: ${quoted(baseBranch)}`,
      `- Work branch: ${quoted(branch)}`,
    ].join("\n"));
    await this.setStatus(target, "In progress");
  }

  /** Report work that cannot proceed and park it on the board. */
  async blocked(target: BacklogTarget, detail: string, subject: string): Promise<void> {
    await this.post(target.identity, "failure", subject, [
      "## Factory blocked",
      "",
      `- Ticket: ${quoted(target.ticketId)}`,
      `- Reason: ${detail}`,
    ].join("\n"));
    await this.setStatus(target, "Blocked");
  }

  /** Report work parked before its authorization lapsed, naming the preserved branch. */
  async preserved(target: BacklogTarget, subject: string, facts: PreservationFacts): Promise<void> {
    await this.post(target.identity, "preservation", subject, [
      "## Factory preserved work",
      "",
      `- Ticket: ${quoted(target.ticketId)}`,
      `- Attempt: ${quoted(facts.attemptId)}`,
      `- Repository: ${quoted(facts.repository)}`,
      `- Branch: ${quoted(facts.branch)}`,
      `- Branch link: ${facts.branchUrl ?? quoted(facts.branch)}`,
      `- Commit: ${quoted(facts.commitSha)}`,
      `- Pushed: ${facts.pushed ? "yes" : `no — ${facts.pushFailure ?? "unknown failure"}`}`,
      `- Reviewed: ${facts.reviewed ? "yes" : "no"}`,
      `- Workspace: ${quoted(facts.workspacePath)}`,
      "",
      "The branch is pushed without a pull request. Restore authorization, then move the issue back to `In progress` to continue.",
    ].join("\n"));
    await this.setStatus(target, "Blocked");
  }

  /** Report work preserved on a pushed branch after a human withdrew authorization, leaving the board status exactly as they set it. */
  async withdrawn(target: BacklogTarget, subject: string, facts: PreservationFacts & Readonly<{ stage: string }>): Promise<void> {
    await this.post(target.identity, "preservation", subject, [
      "## Factory preserved unreviewed work",
      "",
      `- Ticket: ${quoted(target.ticketId)}`,
      `- Attempt: ${quoted(facts.attemptId)}`,
      `- Stopped before: ${quoted(facts.stage)}`,
      `- Repository: ${quoted(facts.repository)}`,
      `- Branch: ${quoted(facts.branch)}`,
      `- Branch link: ${facts.branchUrl ?? quoted(facts.branch)}`,
      `- Commit: ${quoted(facts.commitSha)}`,
      `- Pushed: ${facts.pushed ? "yes" : `no — ${facts.pushFailure ?? "unknown failure"}`}`,
      `- Reviewed: ${facts.reviewed ? "yes" : "no"}`,
      `- Workspace: ${quoted(facts.workspacePath)}`,
      "",
      "Authorization was withdrawn, so the runner stopped this work at a safe boundary and published nothing. The Project status is left exactly as you set it.",
    ].join("\n"));
  }

  /** Return an issue whose recorded publication was retired to the queue, naming why it restarts. */
  async resume(target: BacklogTarget, subject: string): Promise<void> {
    await this.post(target.identity, "comment", subject, [
      "## Factory resumed",
      "",
      `- Ticket: ${quoted(target.ticketId)}`,
      "- Reason: the recorded pull request is no longer an open draft, so this ticket's work is published again from a fresh attempt.",
    ].join("\n"));
    await this.setStatus(target, "In progress");
  }

  /** Record a published draft on every included issue and move them into review. */
  async inReview(targets: readonly BacklogTarget[], publication: ReviewPublication, subject: string): Promise<void> {
    for (const target of targets) {
      await this.post(target.identity, "publication", publication.url, [
        "## Factory pull request",
        "",
        `- Ticket: ${quoted(target.ticketId)}`,
        `- Pull request: #${publication.number} ${publication.url}`,
        `- Title: ${publication.title}`,
        `- Head branch: ${quoted(publication.head)}`,
        `- Source commit: ${quoted(publication.sourceSha)}`,
        `- Requested merge method: ${publication.mergeStrategy} (${publication.squashPreference})`,
      ].join("\n"));
      await this.setStatus(target, "In review");
    }
  }

  /** Close out a merged ticket: settlement comment, `Done`, then closure. */
  async done(target: BacklogTarget, subject: string, facts: Readonly<{ pullRequestUrl: string; mergeCommitSha: string }>): Promise<void> {
    await this.post(target.identity, "settlement", facts.pullRequestUrl, [
      "## Factory merged",
      "",
      `- Ticket: ${quoted(target.ticketId)}`,
      `- Pull request: ${facts.pullRequestUrl}`,
      `- Merge commit: ${quoted(facts.mergeCommitSha)}`,
    ].join("\n"));
    await this.setStatus(target, "Done");
    await this.close(target, facts.mergeCommitSha);
  }

  /** Replay every durable settlement an earlier process left unfinished, without repeating code publication. */
  async recover(): Promise<readonly RecoveredSettlement[]> {
    const snapshot = await this.ledger.load();
    const recovered: RecoveredSettlement[] = [];
    for (const settlement of snapshot.settlements) {
      const target: BacklogTarget = {
        identity: { backlogRepository: this.backlog.repository, number: settlement.issueNumber, nodeId: settlement.issueNodeId, url: settlement.subject },
        ticketId: settlement.ticketId,
        requirementsHash: "",
        title: settlement.ticketId,
      };
      if (settlement.status !== undefined) {
        await this.setStatus(target, settlement.status);
      } else {
        await this.close(target, settlement.detail);
      }
      recovered.push({ ticketId: settlement.ticketId, issueNumber: settlement.issueNumber, detail: settlement.detail });
    }
    return recovered;
  }

  private async statusOptions(): Promise<ReadonlyMap<string, BacklogStatusOption>> {
    const statusField = await this.backlog.validateProject(BACKLOG_STATUSES);
    return new Map(statusField.options.map((option) => [option.name, option]));
  }


  private async option(name: BacklogStatusName): Promise<BacklogStatusOption> {
    this.options ??= await this.statusOptions();
    const option = this.options.get(name);
    if (option === undefined) throw new BacklogConfigurationError(`the configured Project has no ${quoted(name)} status option`);
    return option;
  }

  /** One key-marked comment, written only when that key has produced no comment yet. */
  private async post(identity: IssueIdentity, kind: "comment" | "start" | "failure" | "publication" | "preservation" | "settlement", subject: string, body: string): Promise<void> {
    const marker = commentMarker(operationKey(kind, issueSubject(identity), subject));
    const comments = await this.backlog.listComments(identity.number);
    if (comments.some((comment) => comment.body.includes(marker))) return;
    await this.backlog.createComment(identity.number, this.redact(`${body}\n\n${marker}`));
  }

  /** Durable record, Project write, provider read-back, completion. A transition already in effect is never rewritten. */
  private async setStatus(target: BacklogTarget, status: BacklogStatusName): Promise<void> {
    const current = await this.backlog.findProjectItem(target.identity.nodeId);
    if (current?.status?.name === status) {
      await this.settle(target, `status-${codeOf(status)}`);
      return;
    }
    await this.recordStatus(target, status);
    const option = await this.option(status);
    await this.backlog.setProjectStatus(target.identity.nodeId, option.optionId);
    const applied = await this.backlog.findProjectItem(target.identity.nodeId);
    if (applied?.status?.name !== status) {
      throw new BacklogConfigurationError(
        `the Project did not apply ${quoted(status)} to issue #${target.identity.number}${applied === undefined ? "; the issue is not on the board" : `; it reads back ${quoted(applied.status?.name ?? "no status")}`}`,
      );
    }
    await this.settle(target, `status-${codeOf(status)}`);
  }

  /** Durable record, closure, provider read-back, completion. */
  private async close(target: BacklogTarget, mergeCommitSha: string): Promise<void> {
    const issue = await this.backlog.getIssue(target.identity.number);
    if (issue?.state === "closed") {
      await this.settle(target, `close-${mergeCommitSha}`);
      return;
    }
    await this.recordClose(target, mergeCommitSha);
    await this.backlog.closeIssueCompleted(target.identity.number);
    const closed = await this.backlog.getIssue(target.identity.number);
    if (closed?.state !== "closed") {
      throw new BacklogConfigurationError(`issue #${target.identity.number} is not closed after the closure mutation`);
    }
    await this.settle(target, `close-${mergeCommitSha}`);
  }

  /** Close the settlement record for an effect the board or provider already shows, so a replay ends. */
  private async settle(target: BacklogTarget, keyDetail: string): Promise<void> {
    await this.ledger.completeSettlement(operationKey("settlement", issueSubject(target.identity), keyDetail));
  }

  private async recordStatus(target: BacklogTarget, status: BacklogStatusName): Promise<void> {
    await this.record(target, `status-${codeOf(status)}`, "status", status, status);
  }

  private async recordClose(target: BacklogTarget, mergeCommitSha: string): Promise<void> {
    await this.record(target, `close-${mergeCommitSha}`, "close", undefined, mergeCommitSha);
  }

  /** One settlement record keyed by the issue and the effect, so a restart recognises its own work. */
  private async record(target: BacklogTarget, keyDetail: string, kind: PendingSettlement["kind"], status: BacklogStatusName | undefined, detail: string): Promise<PendingSettlement> {
    const subject = issueSubject(target.identity);
    const settlement: PendingSettlement = {
      version: 1,
      operationKey: operationKey("settlement", subject, keyDetail),
      kind,
      subject,
      ...(status === undefined ? {} : { status }),
      ticketId: target.ticketId,
      issueNumber: target.identity.number,
      issueNodeId: target.identity.nodeId,
      detail,
      recordedAt: this.now().toISOString(),
    };
    await this.ledger.recordSettlement(settlement);
    return settlement;
  }
}
