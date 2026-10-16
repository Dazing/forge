import { parseAuthoredIssueSnapshot, type BacklogStatusName, type IssueIdentity } from "../tickets/index.js";
import type { GitHubBacklog } from "../../infrastructure/github-backlog/index.js";
import type { GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";

// Authorization is the Project board, not the runner's memory: a human can withdraw a ticket at any
// moment. Every stage dispatch and every publication side effect re-reads the authoritative issue
// through one narrow guard, so withdrawal stops work at a safe boundary instead of mid-write.

/** Thrown when the authority that authorized this work has been withdrawn. */
export class AuthorizationWithdrawnError extends Error {
  constructor(
    readonly ticketId: string,
    readonly stage: string,
    readonly observed: string,
  ) {
    super(`Authorization for ticket ${ticketId} was withdrawn before ${stage}: ${observed}.`);
    this.name = "AuthorizationWithdrawnError";
  }
}

export function isAuthorizationWithdrawn(error: unknown): error is AuthorizationWithdrawnError {
  return error instanceof AuthorizationWithdrawnError;
}

/** The callback a stage or publication calls before it starts any agent run, push, or provider write. */
export type StageAuthorization = (stage: string) => Promise<void>;

/** Authoritative remote facts for one issue, read at a side-effect boundary. */
export type IssueAuthorization = Readonly<{
  open: boolean;
  status: BacklogStatusName | undefined;
  requirementsHash: string | undefined;
}>;

/** Read one issue's open state, board status, and authored requirements hash. */
export function createIssueAuthorizationReader(input: Readonly<{ backlog: GitHubBacklog; providers: GitProviderRegistry }>): (identity: IssueIdentity) => Promise<IssueAuthorization> {
  return async (identity) => {
    const issue = await input.backlog.getIssue(identity.number);
    if (issue === undefined) return { open: false, status: undefined, requirementsHash: undefined };
    const item = await input.backlog.findProjectItem(identity.nodeId);
    const status = item?.status?.name as BacklogStatusName | undefined;
    if (issue.state !== "open") return { open: false, status, requirementsHash: undefined };
    return { open: true, status, requirementsHash: parseAuthoredIssueSnapshot(identity, issue.body, input.providers).ticket.requirementsHash };
  };
}

/**
 * Guard one ticket's work: the issue must stay open, stay on the status the runner claimed it on,
 * and keep the authored requirements it was claimed with. Any other answer is withdrawal.
 */
export function createStageAuthorization(guarded: Readonly<{
  ticketId: string;
  identity: IssueIdentity;
  requirementsHash: string;
  claimStatus: BacklogStatusName;
  read: (identity: IssueIdentity) => Promise<IssueAuthorization>;
}>): StageAuthorization {
  return async (stage) => {
    const fact = await guarded.read(guarded.identity);
    if (!fact.open) throw new AuthorizationWithdrawnError(guarded.ticketId, stage, `backlog issue #${guarded.identity.number} is no longer open`);
    if (fact.status !== guarded.claimStatus) {
      throw new AuthorizationWithdrawnError(guarded.ticketId, stage, `its Project status is ${fact.status ?? "unknown"}, not ${guarded.claimStatus}`);
    }
    if (fact.requirementsHash !== guarded.requirementsHash) {
      throw new AuthorizationWithdrawnError(guarded.ticketId, stage, "its authored requirements changed since the work was claimed");
    }
  };
}

/** Guard a group side effect: every member must still authorize the work; the first withdrawal names the member. */
export function createGroupAuthorization(members: readonly StageAuthorization[]): StageAuthorization {
  return async (stage) => {
    for (const authorize of members) await authorize(stage);
  };
}
