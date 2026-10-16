import { createHash } from "node:crypto";
import { parseAuthoredIssueSnapshot, type BacklogStatusName, type Ticket } from "../tickets/index.js";
import { runGit, toCommandFailure } from "../../infrastructure/git-provider/git.js";
import { type ProviderName, type PullRequestRecord } from "../../infrastructure/git-provider/git-provider.js";
import { planGroups, type PlannedGroup } from "../plan-tickets/index.js";
import { publishPullRequest, PublicationError } from "../publish-pull-request/index.js";
import { buildDependencyGraph, type DependencyGraph } from "./dependency-graph.js";
import { executeReviewedAttempt, type ReviewedCheckpoint } from "./execute-attempt.js";
import { integrateCandidates, type IntegrationCheckpoint, type ReviewedCandidate } from "./integrate-candidates.js";
import type { ProcessConfig } from "./process-config.js";
import { logBacklogFailure, reportBlocked } from "./settle-attempt.js";
import { cloneTargetRepository, verifyMergedPublication } from "./reconcile-publication.js";
import { discoverBacklogTickets, type BacklogTicket } from "./backlog-discovery.js";
import { type BacklogTarget, type ReviewPublication } from "./backlog-workflow.js";
import { PUBLICATION_RECORD_VERSION, REQUESTED_MERGE_STRATEGY, operationKey, type PublicationIntent, type PublicationResult } from "./publication-record.js";
import type { WorkspaceBaseline } from "./workspace.js";
import { detectAuthorizationLapse, preserveAttemptWorkspace } from "./authorization-lapse.js";
import { createIssueAuthorizationReader, createStageAuthorization, isAuthorizationWithdrawn, type StageAuthorization } from "./authorization-guard.js";
import { branchBrowserUrl } from "../../infrastructure/git-provider/create-git-provider.js";
import { redactSecrets } from "../../shared/redact-secret.js";

// The private-GitHub backlog is the only ticket source. Scheduling reads open Project issues; every
// lifecycle fact the runner owes the operator is settled on the issue itself, durably recorded in the
// publication ledger first. Nothing here writes ticket files, and a settlement failure never republishes.

/** One published draft, tracked from ledger facts so a restart can extend or retire it identically. */
export type PublicationFact = Readonly<{
  groupId: string;
  includedTicketIds: readonly string[];
  number: number;
  url: string;
  provider: ProviderName;
  repository: string;
  baseBranch: string;
  baseSha: string;
  head: string;
  sourceSha: string;
  title: string;
  body: string;
  squashPreference: "configured" | "unsupported";
  workspacePath: string | undefined;
}>;

/** The ticket identities one recorded publication covers. */
function includedIds(result: PublicationResult): readonly string[] {
  return result.included.map((entry) => entry.ticketId);
}

export interface DependencyWorkflowState {
  cycle: number;
  startupChecked: boolean;
  readonly tickets: Map<string, Ticket>;
  readonly issues: Map<string, BacklogTicket>;
  readonly published: Set<string>;
  readonly settled: Set<string>;
  readonly reviewed: Map<string, ReviewedCheckpoint>;
  readonly blocked: Map<string, string>;
  readonly retryable: Map<string, string>;
  readonly withdrawn: Set<string>;
  readonly publishedBaselines: Map<string, WorkspaceBaseline>;
  readonly retired: Set<string>;
  readonly integrationConflicts: Map<string, readonly Readonly<{ path: string; disposition: string }>[]>;
  readonly publications: Map<string, PublicationFact>;
  readonly groupIdsByTicket: Map<string, string>;
  readonly mergedSatisfied: Map<string, WorkspaceBaseline>;
}

export function createDependencyWorkflowState(): DependencyWorkflowState {
  return {
    cycle: 0,
    startupChecked: false,
    tickets: new Map(),
    issues: new Map(),
    published: new Set(),
    settled: new Set(),
    reviewed: new Map(),
    blocked: new Map(),
    retryable: new Map(),
    withdrawn: new Set(),
    publishedBaselines: new Map(),
    retired: new Set(),
    integrationConflicts: new Map(),
    publications: new Map(),
    groupIdsByTicket: new Map(),
    mergedSatisfied: new Map(),
  };
}

function targetOf(entry: BacklogTicket): BacklogTarget {
  return {
    identity: entry.snapshot.identity,
    ticketId: entry.ticket.id,
    requirementsHash: entry.ticket.requirementsHash,
    title: entry.ticket.title,
  };
}

/** The Project board is the authority: every side-effect boundary re-reads the issue, its status, and its requirements. */
function authorizationFor(ticketId: string, claimStatus: BacklogStatusName, state: DependencyWorkflowState, config: ProcessConfig): StageAuthorization | undefined {
  const entry = state.issues.get(ticketId);
  if (entry === undefined) return undefined;
  return createStageAuthorization({
    ticketId,
    identity: entry.snapshot.identity,
    requirementsHash: entry.ticket.requirementsHash,
    claimStatus,
    read: createIssueAuthorizationReader({ backlog: config.backlog, providers: config.providers }),
  });
}

/**
 * Guard a group side effect. Each member's claim status is resolved when the guard runs, not when it
 * is built: a member the runner has published by then is authorized by the status its publication
 * moved it to (`In review`), and everything else must still sit on the claimed `In progress`. A group
 * can publish several subsets in one cycle, so an earlier subset changes what the next one requires.
 */
function groupAuthorization(ticketIds: readonly string[], state: DependencyWorkflowState, config: ProcessConfig): StageAuthorization | undefined {
  const members = ticketIds.filter((id) => state.issues.has(id));
  if (members.length === 0) return undefined;
  return async (stage) => {
    for (const ticketId of members) {
      const guard = authorizationFor(ticketId, state.published.has(ticketId) ? "In review" : "In progress", state, config);
      if (guard !== undefined) await guard(stage);
    }
  };
}

async function discover(config: ProcessConfig, state: DependencyWorkflowState): Promise<void> {
  const discovery = await discoverBacklogTickets(config.backlog, config.providers);
  for (const failure of discovery.failures) {
    console.error(`Backlog issue #${failure.issueNumber} (${failure.issueUrl}) is not a schedulable ticket: ${failure.reason}`);
  }
  for (const duplicate of discovery.duplicates) {
    console.error(`Ticket ${duplicate.ticketId} is declared by open issues ${duplicate.issueNumbers.join(", ")}; none of them are scheduled.`);
    const reason = `duplicate open ticket identity ${duplicate.ticketId}; operator reconciliation required`;
    for (const number of duplicate.issueNumbers) {
      try {
        const issue = await config.backlog.getIssue(number);
        if (issue === undefined || issue.state !== "open") continue;
        const snapshot = parseAuthoredIssueSnapshot({
          backlogRepository: config.backlog.repository, number, nodeId: issue.nodeId, url: issue.url,
        }, issue.body, config.providers);
        await reportBlocked(config, snapshot.ticket, reason);
        await reportSettlement(config, duplicate.ticketId, "duplicate identity", () => config.workflow.blocked({
          identity: snapshot.identity, ticketId: snapshot.ticket.id,
          requirementsHash: snapshot.ticket.requirementsHash, title: snapshot.ticket.title,
        }, reason, blockingReasonKey(reason)));
      } catch (error) {
        await logBacklogFailure(config, duplicate.ticketId, "duplicate identity", error);
      }
    }
  }
  for (const number of discovery.unboarded) {
    console.error(`Backlog issue #${number} has no item in the configured Project; it is never scheduled.`);
  }

  const found = new Map(discovery.tickets.map((entry) => [entry.ticket.id, entry]));
  for (const id of state.issues.keys()) {
    if (found.has(id)) continue;
    state.issues.delete(id);
    state.tickets.delete(id);
    state.reviewed.delete(id);
    state.published.delete(id);
    state.publishedBaselines.delete(id);
  }
  for (const [id, entry] of found) {
    const known = state.issues.get(id);
    if (known !== undefined && known.snapshot.identity.number !== entry.snapshot.identity.number) {
      state.blocked.set(id, `ticket ${id} was rediscovered on issue #${entry.snapshot.identity.number} after issue #${known.snapshot.identity.number}; operator reconciliation required`);
    }
    const checkpoint = state.reviewed.get(id);
    if (checkpoint !== undefined && checkpoint.requirementsHash !== entry.ticket.requirementsHash) {
      state.blocked.set(id, `requirements changed after successful checkpoint; author a new ticket instead of reusing ${id}`);
    }
    state.issues.set(id, entry);
    if (state.withdrawn.has(id) && entry.status === "Ready for development") {
      state.withdrawn.delete(id);
      state.blocked.delete(id);
      state.reviewed.delete(id);
    }
    state.tickets.set(id, entry.ticket);
  }
  if (!state.startupChecked) {
    await settleRecordedEffects(config, state);
    state.startupChecked = true;
  }
}

/**
 * One startup pass over durable evidence: unfinished settlements are replayed, recorded publications
 * are reconciled with their provider, and each discovered issue's board status decides what happens
 * to it. Closure is terminal; an issue reopened after its recorded closure is fresh work.
 */
async function settleRecordedEffects(config: ProcessConfig, state: DependencyWorkflowState): Promise<void> {
  for (const entry of await config.workflow.recover()) {
    console.log(`[startup] Replayed the recorded settlement ${entry.detail} for issue #${entry.issueNumber}.`);
  }
  let snapshot = await config.ledger.load();
  await recoverPublicationIntents(config, state, snapshot.intents, snapshot.results);
  snapshot = await config.ledger.load();
  const results = currentPublicationResults(snapshot.results);
  for (const record of snapshot.corrupt) {
    console.error(`[startup] Unreadable ledger record ${record.file} requires operator reconciliation; it is never rewritten or deleted.`);
  }
  for (const result of results) {
    await reconcileResult(config, state, result);
  }

  const closures = new Map(snapshot.settlements.filter((record) => record.kind === "close").map((record) => [record.issueNumber, record.operationKey]));
  for (const [ticketId, entry] of [...state.issues]) {
    const closeKey = closures.get(entry.snapshot.identity.number);
    if (closeKey !== undefined) {
      // The runner closed this issue and it is open again, so an author reopened it: the closure is retired and the work is fresh.
      await config.ledger.completeSettlement(closeKey);
      closures.delete(entry.snapshot.identity.number);
      console.log(`Issue #${entry.snapshot.identity.number} (${ticketId}) was reopened after its recorded closure; it is scheduled as fresh work.`);
    }
    if (state.settled.has(ticketId)) continue;
    const result = results.find((candidate) => includedIds(candidate).includes(ticketId));
    switch (entry.status) {
      case "In review": {
        if (result === undefined) {
          state.blocked.set(ticketId, "the issue is In review with no recorded pull request; operator reconciliation required");
        } else if (!state.publications.has(result.groupId) && !state.settled.has(ticketId)) {
          state.blocked.set(ticketId, `pull request ${result.pullRequestNumber} for ${ticketId} is no longer an open draft; operator reconciliation required`);
        } else {
          state.published.add(ticketId);
        }
        break;
      }
      case "In progress": {
        const publication = result !== undefined ? state.publications.get(result.groupId) : undefined;
        if (publication !== undefined) {
          await reportSettlement(config, ticketId, "in review", () => config.workflow.inReview([targetOf(entry)], publicationFacts(publication), `group-${publication.groupId}`));
        }
        console.log(`Issue #${entry.snapshot.identity.number} (${ticketId}) is In progress; its work resumes with a fresh attempt.`);
        break;
      }
      case "Blocked": {
        console.log(`Issue #${entry.snapshot.identity.number} (${ticketId}) is Blocked; the runner leaves it parked.`);
        break;
      }
      default:
        break;
    }
  }
}

/** Historical revisions remain durable evidence, but only the newest revision owns settlement. */
function currentPublicationResults(results: readonly PublicationResult[]): PublicationResult[] {
  const current = new Map<string, PublicationResult>();
  for (const result of [...results].sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))) {
    current.set(`${result.provider}\0${result.repository}\0${result.pullRequestNumber}`, result);
  }
  return [...current.values()];
}

async function recoverPublicationIntents(config: ProcessConfig, state: DependencyWorkflowState, intents: readonly PublicationIntent[], results: readonly PublicationResult[]): Promise<void> {
  const completed = new Set(results.map((result) => result.operationKey));
  for (const intent of intents) {
    if (completed.has(intent.operationKey)) continue;
    try {
      const provider = config.providers.resolve(intent.repository);
      let record = await provider.findPullRequest({ repository: intent.repository, head: intent.head, base: intent.baseBranch });
      if (record !== undefined && provider.getPullRequest !== undefined) {
        const details = await provider.getPullRequest(intent.repository, record.number);
        if (details === undefined) throw new Error("the located publication could not be read back");
        record = { ...record, sourceSha: details.sourceSha, title: details.title, body: details.body,
          draft: details.draft, state: details.state, headBranch: details.head, baseBranch: details.base,
          mergeMethod: details.squashPreference === "configured" ? "squash" : "unknown",
          mergeCommitSha: details.mergeResultSha };
      }
      if (record === undefined) {
        // Exact branch lookup found no PR: a push alone has no publication to adopt.
        await config.ledger.retirePublication(intent.operationKey);
        continue;
      }
      if (record.sourceSha !== intent.sourceSha || record.title !== intent.title || record.body !== intent.body
        || record.headBranch !== intent.head || record.baseBranch !== intent.baseBranch
        || (record.state === "open" && !record.draft) || (provider.mergeStrategySupport === "configured" && record.mergeMethod !== "squash")) {
        throw new Error("the publication intent does not match the remote pull-request identity");
      }
      await config.ledger.writeResult({
        ...intent, pullRequestNumber: record.number, pullRequestUrl: record.url,
        squashPreference: provider.mergeStrategySupport, publishedAt: new Date().toISOString(),
      });
    } catch (error) {
      const reason = `uncertain publication requires operator reconciliation: ${error instanceof Error ? error.message : String(error)}`;
      for (const included of intent.included) state.blocked.set(included.ticketId, reason);
    }
  }
}

function publicationFacts(publication: PublicationFact): ReviewPublication {
  return {
    number: publication.number,
    url: publication.url,
    head: publication.head,
    sourceSha: publication.sourceSha,
    mergeStrategy: "squash",
    squashPreference: publication.squashPreference,
    title: publication.title,
  };
}

/** One backlog settlement whose failure is recorded and reported but never changes already-published code. */
async function reportSettlement(config: ProcessConfig, ticketId: string, stage: string, effect: () => Promise<void>): Promise<boolean> {
  try {
    await effect();
    return true;
  } catch (error) {
    await logBacklogFailure(config, ticketId, stage, error);
    console.error(`Ticket ${ticketId} backlog settlement failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function blockDescendants(state: DependencyWorkflowState, ticketId: string, reason: string): void {
  for (const ticket of state.tickets.values()) {
    if (ticket.dependsOnTickets.includes(ticketId)) state.blocked.set(ticket.id, reason);
  }
}

/**
 * Reconcile one recorded publication with its provider: a merged pull request is verified and its
 * tickets closed out, a retired pull request is un-recorded so its work can be published again, and
 * an open draft is tracked so a reviewed descendant can extend it.
 */
async function reconcileResult(config: ProcessConfig, state: DependencyWorkflowState, result: PublicationResult): Promise<void> {
  const subject = `pull-request-${result.pullRequestNumber}`;
  let record: PullRequestRecord | undefined;
  try {
    const provider = config.providers.resolve(result.repository);
    if (provider.getPullRequest !== undefined) {
      const details = await provider.getPullRequest(result.repository, result.pullRequestNumber);
      record = details === undefined ? undefined : {
        provider: provider.name, repository: result.repository, number: details.number, url: details.url,
        baseBranch: details.base, headBranch: details.head, sourceSha: details.sourceSha,
        title: details.title, body: details.body, draft: details.draft, state: details.state,
        mergeMethod: details.squashPreference === "configured" ? "squash" : "unknown",
        mergeCommitSha: details.mergeResultSha,
      };
    } else {
      record = await provider.findPullRequest({ repository: result.repository, base: result.baseBranch, head: result.head });
    }
  } catch (error) {
    const reason = `pull-request reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
    for (const ticketId of includedIds(result)) blockDescendants(state, ticketId, reason);
    return;
  }

  if (record === undefined || record.state === "closed") {
    for (const revision of (await config.ledger.load()).results) {
      if (revision.provider === result.provider && revision.repository === result.repository && revision.pullRequestNumber === result.pullRequestNumber) {
        await config.ledger.retirePublication(revision.operationKey);
      }
    }
    state.publications.delete(result.groupId);
    console.error(`Pull request ${result.pullRequestUrl} is ${record === undefined ? "absent" : "closed"}; its recorded publication is retired and its tickets return to Ready for development pending restart.`);
    for (const ticketId of includedIds(result)) {
      state.published.delete(ticketId);
      state.retired.add(ticketId);
      state.publishedBaselines.delete(ticketId);
      state.blocked.set(ticketId, "retired publication requires operator reconciliation until restart");
      const entry = state.issues.get(ticketId);
      if (entry?.status === "In review") {
        await reportSettlement(config, ticketId, "resume", () => config.workflow.resume(targetOf(entry), subject));
      }
    }
    return;
  }
  if (record.sourceSha !== result.sourceSha || record.headBranch !== result.head || record.baseBranch !== result.baseBranch
    || record.title !== result.title || record.body !== result.body || (record.state === "open" && !record.draft)) {
    for (const ticketId of includedIds(result)) {
      state.blocked.set(ticketId, `pull request ${result.pullRequestNumber} changed externally; operator reconciliation required`);
    }
    return;
  }

  const tracked = state.publications.get(result.groupId);
  state.publications.set(result.groupId, publicationOf(result, tracked?.workspacePath));
  if (record.state !== "merged") {
    try {
      let baseline = state.publishedBaselines.get(includedIds(result)[0]!);
      if (baseline?.sha !== result.sourceSha) {
        const repositoryPath = tracked?.workspacePath ?? await cloneTargetRepository(result.repository, result.baseBranch);
        await runGit(repositoryPath, ["fetch", "origin", `refs/heads/${result.head}`], "recovering published dependency baseline");
        const sha = (await runGit(repositoryPath, ["rev-parse", "FETCH_HEAD"], "validating published dependency SHA")).trim();
        if (sha !== result.sourceSha) throw new Error("published dependency branch changed while recovering its baseline");
        await runGit(repositoryPath, ["merge-base", "--is-ancestor", result.baseSha, sha], "validating published dependency ancestry");
        baseline = { repositoryPath, sha };
      }
      state.publications.set(result.groupId, publicationOf(result, baseline.repositoryPath));
      for (const included of result.included) {
        const entry = state.issues.get(included.ticketId);
        if (entry !== undefined && (entry.ticket.requirementsHash !== included.requirementsHash || entry.snapshot.identity.nodeId !== included.issueNodeId)) {
          throw new Error(`published ticket ${included.ticketId} no longer matches its recorded requirements/issue`);
        }
        state.published.add(included.ticketId);
        state.publishedBaselines.set(included.ticketId, baseline);
        state.groupIdsByTicket.set(included.ticketId, result.groupId);
      }
    } catch (error) {
      for (const ticketId of includedIds(result)) blockDescendants(state, ticketId, `published baseline recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }

  if (record.mergeCommitSha === undefined) {
    for (const ticketId of includedIds(result)) {
      blockDescendants(state, ticketId, `merged pull request ${result.pullRequestNumber} has no verifiable merge-result commit`);
    }
    return;
  }

  let verifyPath: string;
  try {
    verifyPath = tracked?.workspacePath ?? (await cloneTargetRepository(result.repository, result.baseBranch));
  } catch (error) {
    for (const ticketId of includedIds(result)) {
      blockDescendants(state, ticketId, `merged-work verification failed for pull request ${result.pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  let refreshedSha: string;
  try {
    refreshedSha = await verifyMergedPublication({ workspacePath: verifyPath, baseBranch: result.baseBranch, baseSha: result.baseSha, publishedSha: result.sourceSha }, record.mergeCommitSha);
  } catch (error) {
    for (const ticketId of includedIds(result)) {
      blockDescendants(state, ticketId, `merged-work verification failed for pull request ${result.pullRequestNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  for (const prior of (await config.ledger.load()).results) {
    if (prior.repository !== result.repository || prior.baseBranch !== result.baseBranch) continue;
    for (const id of includedIds(prior)) {
      const baseline = state.mergedSatisfied.get(id);
      if (baseline === undefined) continue;
      const reachable = await runGit(verifyPath, ["merge-base", "--is-ancestor", baseline.sha, refreshedSha], "checking refreshed prerequisite reachability").then(() => true, () => false);
      if (reachable) state.mergedSatisfied.set(id, { sha: refreshedSha, repositoryPath: verifyPath });
    }
  }
  for (const ticketId of includedIds(result)) {
    state.mergedSatisfied.set(ticketId, { sha: refreshedSha, repositoryPath: verifyPath });
    const entry = state.issues.get(ticketId);
    if (entry === undefined) continue;
    const settled = await reportSettlement(config, ticketId, "done", () =>
      config.workflow.done(targetOf(entry), subject, { pullRequestUrl: result.pullRequestUrl, mergeCommitSha: record!.mergeCommitSha! }));
    if (!settled) continue;
    state.settled.add(ticketId);
    state.published.delete(ticketId);
    state.reviewed.delete(ticketId);
    state.issues.delete(ticketId);
    state.tickets.delete(ticketId);
    console.log(`Issue #${entry.snapshot.identity.number} (${ticketId}) is merged at ${refreshedSha}; recorded as Done and closed.`);
  }
}

function publicationOf(result: PublicationResult, workspacePath: string | undefined): PublicationFact {
  return {
    groupId: result.groupId,
    includedTicketIds: includedIds(result),
    number: result.pullRequestNumber,
    url: result.pullRequestUrl,
    provider: result.provider,
    repository: result.repository,
    baseBranch: result.baseBranch,
    baseSha: result.baseSha,
    head: result.head,
    sourceSha: result.sourceSha,
    title: result.title,
    body: result.body,
    squashPreference: result.squashPreference,
    workspacePath,
  };
}

function deliveryGroups(graph: DependencyGraph, state: DependencyWorkflowState) {
  return graph.groups.map((group) => {
    const retainedId = group.memberIds.map((id) => state.groupIdsByTicket.get(id)).find((id) => id !== undefined) ?? group.id;
    for (const memberId of group.memberIds) state.groupIdsByTicket.set(memberId, retainedId);
    return { ...group, id: retainedId };
  });
}

function dependencyClosure(ticketId: string, tickets: ReadonlyMap<string, Ticket>, included = new Set<string>()): Set<string> {
  if (included.has(ticketId)) return included;
  included.add(ticketId);
  for (const dependencyId of tickets.get(ticketId)?.dependsOnTickets ?? []) dependencyClosure(dependencyId, tickets, included);
  return included;
}

function baselineFor(ticket: Ticket, state: DependencyWorkflowState): WorkspaceBaseline | undefined {
  if (ticket.dependsOnTickets.length === 0) return undefined;
  if (ticket.dependsOnTickets.length !== 1) throw new Error(`Ticket ${ticket.id} requires a reviewed multi-parent integration baseline.`);
  const parentId = ticket.dependsOnTickets[0]!;
  const merged = state.mergedSatisfied.get(parentId);
  if (merged !== undefined) return merged;
  const published = state.publishedBaselines.get(parentId);
  if (published !== undefined) return published;
  const parent = state.reviewed.get(parentId);
  if (parent === undefined) throw new Error(`Ticket ${ticket.id} dependency ${parentId} is not reviewed.`);
  return { sha: parent.reviewCheckpoint.checkpointSha, repositoryPath: parent.workspacePath };
}

async function runTicket(ticket: Ticket, state: DependencyWorkflowState, config: ProcessConfig, baseline?: WorkspaceBaseline): Promise<"reviewed" | "deferred" | "blocked"> {
  const entry = state.issues.get(ticket.id)!;
  const target = targetOf(entry);
  for (let attempt = 1; attempt <= config.ticketAttemptsPerCycle; attempt++) {
    const authorize = authorizationFor(ticket.id, "In progress", state, config);
    const result = await executeReviewedAttempt(ticket, config, (attemptId, branch) =>
      config.workflow.claim(target, attemptId, branch, ticket.repository, ticket.baseBranch), baseline, authorize);
    if (result.status === "withdrawn") {
      const reason = `authorization was withdrawn at ${result.stage}: ${result.observed}`;
      state.blocked.set(ticket.id, reason);
      state.withdrawn.add(ticket.id);
      await reportSettlement(config, ticket.id, "withdrawn", () =>
        config.workflow.withdrawn(target, `attempt-${result.attemptId}`, {
          attemptId: result.attemptId,
          stage: result.stage,
          repository: ticket.repository,
          branch: result.branch,
          branchUrl: branchBrowserUrl(ticket.repository, result.branch),
          commitSha: result.preserved?.commitSha ?? "unrecorded",
          baseBranch: ticket.baseBranch,
          workspacePath: result.workspacePath,
          pushed: result.preserved?.pushed ?? false,
          pushFailure: result.preserved?.pushFailure ?? "the preserved workspace HEAD could not be pushed",
          captureComplete: result.preserved?.captureComplete ?? false,
          captureFailure: result.preserved?.captureFailure ?? "the workspace could not be captured",
          reviewed: false,
        }));
      return "blocked";
    }
    if (result.status === "failed") {
      if (!result.retryable) {
        const lapse = detectAuthorizationLapse(result.failure.stderr, config.providers.secrets);
        if (lapse !== undefined && result.workspacePath !== undefined && result.branch !== undefined) {
          const facts = await preserveAttemptWorkspace({
            attemptId: result.attemptId,
            branch: result.branch,
            repository: ticket.repository,
            baseBranch: ticket.baseBranch,
            workspacePath: result.workspacePath,
            secrets: config.providers.secrets,
          }).catch(() => undefined);
          if (facts !== undefined) {
            state.blocked.set(ticket.id, `${result.stage} stopped by an authorization lapse (${lapse.source}); work is preserved on branch ${facts.branch} at ${facts.commitSha}`);
            await reportSettlement(config, ticket.id, "preserved", () => config.workflow.preserved(target, `attempt-${result.attemptId}`, { ...facts, branchUrl: branchBrowserUrl(ticket.repository, facts.branch), reviewed: false }));
            return "blocked";
          }
        }
        const reason = `${result.stage} failed after a durable boundary; operator reconciliation required`;
        state.blocked.set(ticket.id, reason);
        await reportSettlement(config, ticket.id, "blocked", () => config.workflow.blocked(target, reason, `attempt-${result.attemptId}`));
        return "blocked";
      }
      if (attempt === config.ticketAttemptsPerCycle) {
        const reason = `${result.stage}: ${result.failure.stderr}`;
        state.retryable.set(ticket.id, reason);
        await reportSettlement(config, ticket.id, "blocked", () =>
          config.workflow.blocked(target, `${reason}\n\nThe attempt's workspace is retained on the runner; no pull request was published.`, `attempts-${state.cycle}`));
        return "deferred";
      }
      continue;
    }
    let requirementsHash: string;
    try {
      const latest = await config.backlog.getIssue(entry.snapshot.identity.number);
      if (latest === undefined) throw new Error("the issue is no longer readable");
      requirementsHash = parseAuthoredIssueSnapshot(entry.snapshot.identity, latest.body, config.providers).ticket.requirementsHash;
    } catch (error) {
      await logBacklogFailure(config, ticket.id, "requirements recheck", error);
      state.blocked.set(ticket.id, "ticket requirements could not be rechecked after review; the retained checkpoint was not adopted");
      return "blocked";
    }
    if (requirementsHash !== ticket.requirementsHash) {
      state.blocked.set(ticket.id, `requirements changed during the attempt; the retained workspace was not adopted`);
      return "blocked";
    }
    state.retryable.delete(ticket.id);
    state.reviewed.set(ticket.id, result.checkpoint);
    return "reviewed";
  }
  return "deferred";
}

async function prepareMultiParentBaselines(
  groupId: string,
  ready: readonly Ticket[],
  state: DependencyWorkflowState,
  config: ProcessConfig,
): Promise<Map<string, WorkspaceBaseline>> {
  const baselines = new Map<string, WorkspaceBaseline>();
  for (const ticket of ready) {
    if (ticket.dependsOnTickets.length < 2) continue;
    const mergedBaseline = ticket.dependsOnTickets.map((id) => state.mergedSatisfied.get(id)).find((value) => value !== undefined);
    const unmergedParentIds = ticket.dependsOnTickets.filter((id) => !state.mergedSatisfied.has(id));
    if (unmergedParentIds.length === 0) {
      baselines.set(ticket.id, mergedBaseline!);
      continue;
    }
    const parents = unmergedParentIds.map((id): IntegrationCheckpoint | undefined => {
      const reviewed = state.reviewed.get(id);
      if (reviewed !== undefined) return reviewed;
      const baseline = state.publishedBaselines.get(id);
      const publication = [...state.publications.values()].find((item) => item.includedTicketIds.includes(id));
      const ticket = state.tickets.get(id);
      return baseline === undefined || publication === undefined || ticket === undefined ? undefined : {
        ticket, workspacePath: baseline.repositoryPath, branch: publication.head,
        reviewCheckpoint: { checkpointSha: baseline.sha },
      };
    }).filter((parent): parent is IntegrationCheckpoint => parent !== undefined);
    if (parents.length !== unmergedParentIds.length) continue;
    if (parents.length === 1 && mergedBaseline === undefined) {
      baselines.set(ticket.id, { sha: parents[0]!.reviewCheckpoint.checkpointSha, repositoryPath: parents[0]!.workspacePath });
      continue;
    }
    try {
      const integrated = await integrateCandidates(`${groupId}-${ticket.id}-baseline`, parents, config, mergedBaseline, groupAuthorization(parents.map((parent) => parent.ticket.id), state, config));
      baselines.set(ticket.id, { sha: integrated.sha, repositoryPath: integrated.workspacePath });
      state.integrationConflicts.set(groupId, [...(state.integrationConflicts.get(groupId) ?? []), ...integrated.conflicts]);
    } catch (error) {
      state.blocked.set(ticket.id, `multi-parent integration review failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return baselines;
}

async function publishReviewedSubset(
  groupId: string,
  checkpoints: readonly ReviewedCheckpoint[],
  state: DependencyWorkflowState,
  config: ProcessConfig,
  integrated?: ReviewedCandidate,
  authorize?: StageAuthorization,
): Promise<void> {
  const candidate = integrated ?? await integrateCandidates(groupId, checkpoints, config, undefined, authorize);
  const includedSet = new Set<string>();
  for (const checkpoint of checkpoints) dependencyClosure(checkpoint.ticket.id, state.tickets, includedSet);
  const includedTicketIds = [...includedSet].filter((id) => !state.mergedSatisfied.has(id) && (state.reviewed.has(id) || state.published.has(id))).sort();
  const representative = checkpoints[0]!.ticket;
  const graph = buildDependencyGraph([...state.tickets.values()], new Set(state.mergedSatisfied.keys()));
  const groupMembers = graph.groups.find((group) => group.memberIds.includes(representative.id))?.memberIds ?? includedTicketIds;
  const tracked = state.publications.get(groupId);
  const publicationAttemptId = `group-${groupId}-${candidate.sha.slice(0, 12)}`;
  const baseSha = (await runGit(candidate.workspacePath, ["rev-parse", `origin/${representative.baseBranch}`], "reading publication base SHA")).trim();
  const provider = config.providers.resolve(representative.repository);
  let intent: PublicationIntent = {
    version: PUBLICATION_RECORD_VERSION,
    operationKey: operationKey("publication", `group-${groupId}`, candidate.sha),
    groupId,
    provider: provider.name,
    repository: representative.repository,
    baseBranch: representative.baseBranch,
    baseSha,
    head: candidate.branch,
    sourceSha: candidate.sha,
    title: tracked?.title ?? "",
    body: tracked?.body ?? "",
    mergeStrategy: REQUESTED_MERGE_STRATEGY,
    included: includedTicketIds.map((id) => {
      const issue = state.issues.get(id)!.snapshot.identity;
      return { ticketId: id, issueNumber: issue.number, issueNodeId: issue.nodeId, requirementsHash: state.issues.get(id)!.ticket.requirementsHash };
    }),
    recordedAt: new Date().toISOString(),
  };
  const result = await publishPullRequest({
    ticket: representative,
    workspacePath: candidate.workspacePath,
    branch: candidate.branch,
    attemptId: publicationAttemptId,
    harness: config.harness,
    runAgent: config.runAgent,
    ...(authorize === undefined ? {} : { authorize }),
    gitProvider: provider,
    forbiddenSecrets: config.providers.secrets,
    onPublicationIntent: async (facts) => {
      intent = { ...intent, ...facts };
      await config.ledger.writeIntent(intent);
    },
    onContentComplete: (head, logReference) => config.logger.record({
      timestamp: new Date().toISOString(),
      ticketId: representative.id,
      attemptId: publicationAttemptId,
      stage: "pull-request content",
      operation: "generating group pull-request content",
      status: "completed",
      checkpointSha: head,
      changes: "unchanged",
      agentLogReference: logReference,
    }),
    delivery: {
      included: includedTicketIds.map((id) => ({ id, title: state.tickets.get(id)!.title })),
      retryable: groupMembers
        .filter((id) => state.retryable.has(id))
        .map((id) => ({ id, reason: state.retryable.get(id)! })),
      blocked: groupMembers
        .filter((id) => state.blocked.has(id))
        .map((id) => ({ id, reason: state.blocked.get(id)! })),
      integrationExcluded: groupMembers
        .filter((id) => state.reviewed.has(id) && !includedSet.has(id))
        .map((id) => ({ id, reason: "not part of this dependency-closed reviewed subset" })),
      conflicts: [...(state.integrationConflicts.get(groupId) ?? []), ...candidate.conflicts],
    },
    ...(tracked === undefined ? {} : {
      trackedPublication: {
        number: tracked.number,
        head: tracked.head,
        sourceSha: tracked.sourceSha,
        title: tracked.title,
        body: tracked.body,
      },
    }),
  });

  const published: PublicationResult = {
    ...intent,
    head: result.head,
    sourceSha: result.finalSha,
    pullRequestNumber: result.pullRequest.number,
    pullRequestUrl: result.pullRequest.url,
    squashPreference: result.squashPreference,
    title: result.title,
    body: result.body,
    publishedAt: new Date().toISOString(),
  };
  await config.ledger.writeResult(published);

  // Publication is durable before backlog settlement. Never publish it again because a comment or status failed.
  const previouslyPublished = new Set([...state.publications.values()].flatMap((publication) => publication.includedTicketIds));
  state.publications.set(groupId, publicationOf(published, candidate.workspacePath));
  const newlyIncludedIds = includedTicketIds.filter((id) => !previouslyPublished.has(id));
  const targets = newlyIncludedIds.map((id) => state.issues.get(id)).filter((entry) => entry !== undefined).map(targetOf);
  const settled = await reportSettlement(config, representative.id, "in review", () =>
    config.workflow.inReview(targets, publicationFacts(state.publications.get(groupId)!), `group-${groupId}`));
  for (const id of newlyIncludedIds) {
    if (!settled) {
      state.blocked.set(id, `pull request ${published.pullRequestNumber} was published but not recorded on its issue; operator reconciliation required`);
      continue;
    }
    state.published.add(id);
  }
}

async function publishGroup(groupId: string, state: DependencyWorkflowState, config: ProcessConfig): Promise<void> {
  const graph = buildDependencyGraph([...state.tickets.values()], new Set(state.mergedSatisfied.keys()));
  const group = deliveryGroups(graph, state).find((candidate) => candidate.id === groupId);
  if (group === undefined) return;
  const reviewedIds = group.memberIds.filter((id) => state.reviewed.has(id) && !state.blocked.has(id));
  if (reviewedIds.length === 0) return;
  const prior = state.publications.get(groupId);
  if (prior !== undefined && reviewedIds.every((id) => prior.includedTicketIds.includes(id))) return;
  const leafIds = reviewedIds.filter((id) => !reviewedIds.some((other) => state.tickets.get(other)?.dependsOnTickets.includes(id)));
  const leafCheckpoints = leafIds.map((id) => state.reviewed.get(id)!);
  const obsolete = leafCheckpoints.filter((checkpoint) => checkpoint.ticket.dependsOnTickets.some((dependencyId) => {
    const merged = state.mergedSatisfied.get(dependencyId);
    return merged !== undefined && checkpoint.baselineSha !== merged.sha;
  }));
  if (obsolete.length > 0) {
    for (const checkpoint of obsolete) {
      state.reviewed.delete(checkpoint.ticket.id);
      state.retryable.set(checkpoint.ticket.id, "reviewed checkpoint baseline became obsolete after remote merge reconciliation");
    }
    return;
  }
  const authorizingIds = [...new Set(reviewedIds.flatMap((id) => [...dependencyClosure(id, state.tickets)]))]
    .filter((id) => !state.mergedSatisfied.has(id));
  const authorize = groupAuthorization(authorizingIds, state, config);
  const withdraw = async (stage: string, observed: string, branch: string, commitSha: string, workspacePath: string): Promise<void> => {
    for (const checkpoint of leafCheckpoints) {
      const entry = state.issues.get(checkpoint.ticket.id);
      if (entry === undefined) continue;
      state.blocked.set(checkpoint.ticket.id, `authorization was withdrawn at ${stage}: ${observed}`);
      state.withdrawn.add(checkpoint.ticket.id);
      const preserved = await preserveAttemptWorkspace({
        attemptId: checkpoint.attemptId, repository: checkpoint.ticket.repository,
        baseBranch: checkpoint.ticket.baseBranch, branch, workspacePath, secrets: config.providers.secrets,
      }).catch(() => undefined);
      await reportSettlement(config, checkpoint.ticket.id, "withdrawn", () =>
        config.workflow.withdrawn(targetOf(entry), `group-${groupId}`, {
          attemptId: checkpoint.attemptId,
          stage,
          repository: checkpoint.ticket.repository,
          branch,
          branchUrl: branchBrowserUrl(checkpoint.ticket.repository, branch),
          commitSha: preserved?.commitSha ?? commitSha,
          baseBranch: checkpoint.ticket.baseBranch,
          workspacePath,
          pushed: preserved?.pushed ?? false,
          pushFailure: preserved?.pushFailure ?? "the workspace could not be preserved",
          captureComplete: preserved?.captureComplete ?? false,
          captureFailure: preserved?.captureFailure ?? "the workspace could not be captured",
          reviewed: true,
        }));
    }
  };
  let candidate: ReviewedCandidate;
  try {
    candidate = await integrateCandidates(groupId, leafCheckpoints, config, undefined, authorize);
  } catch (error) {
    if (isAuthorizationWithdrawn(error)) {
      const only = leafCheckpoints[0]!;
      await withdraw(error.stage, error.observed, only.branch, only.reviewCheckpoint.checkpointSha, only.workspacePath);
      return;
    }
    if (leafCheckpoints.length === 1) {
      await settlePublicationFailure(config, state, leafCheckpoints, error);
      return;
    }
    for (const checkpoint of leafCheckpoints) {
      const subsetId = `${groupId}-${checkpoint.ticket.id}`;
      if (!state.publications.has(subsetId)) {
        try {
          await publishReviewedSubset(subsetId, [checkpoint], state, config, undefined, authorize);
        } catch (failure) {
          const cause = failure instanceof PublicationError ? failure.cause : failure;
          if (isAuthorizationWithdrawn(cause)) {
            await withdraw(cause.stage, cause.observed, checkpoint.branch, checkpoint.reviewCheckpoint.checkpointSha, checkpoint.workspacePath);
          } else {
            await settlePublicationFailure(config, state, [checkpoint], failure);
          }
        }
      }
    }
    return;
  }
  try {
    await publishReviewedSubset(groupId, leafCheckpoints, state, config, candidate, authorize);
  } catch (error) {
    const cause = error instanceof PublicationError ? error.cause : error;
    if (isAuthorizationWithdrawn(cause)) {
      await withdraw(cause.stage, cause.observed, candidate.branch, candidate.sha, candidate.workspacePath);
    } else {
      await settlePublicationFailure(config, state, leafCheckpoints, error);
    }
  }
}

async function settlePublicationFailure(config: ProcessConfig, state: DependencyWorkflowState, checkpoints: readonly ReviewedCheckpoint[], error: unknown): Promise<void> {
  const stage = error instanceof PublicationError ? error.substage : "integration";
  const cause = error instanceof PublicationError ? error.cause : error;
  const failure = toCommandFailure(cause, stage);
  const reason = redactSecrets(config.providers.secrets, `${stage}: ${failure.stderr}`);
  for (const checkpoint of checkpoints) {
    state.blocked.set(checkpoint.ticket.id, reason);
    await logBacklogFailure(config, checkpoint.ticket.id, stage, cause);
    const entry = state.issues.get(checkpoint.ticket.id);
    if (entry !== undefined) {
      if (detectAuthorizationLapse(failure.stderr, config.providers.secrets) !== undefined) {
        const preserved = await preserveAttemptWorkspace({
          attemptId: checkpoint.attemptId, branch: checkpoint.branch, repository: checkpoint.ticket.repository,
          baseBranch: checkpoint.ticket.baseBranch, workspacePath: checkpoint.workspacePath, secrets: config.providers.secrets,
        }).catch(() => undefined);
        if (preserved !== undefined) {
          await reportSettlement(config, checkpoint.ticket.id, stage, () => config.workflow.preserved(targetOf(entry), blockingReasonKey(reason), {
            ...preserved, branchUrl: branchBrowserUrl(checkpoint.ticket.repository, preserved.branch), reviewed: true,
          }));
          continue;
        }
      }
      await reportSettlement(config, checkpoint.ticket.id, stage, () => config.workflow.blocked(targetOf(entry), reason, blockingReasonKey(reason)));
    }
  }
}

/** Re-reconcile every recorded publication, so a merge observed mid-cycle settles before descendants publish. */
async function reconcileRecordedPublications(config: ProcessConfig, state: DependencyWorkflowState): Promise<void> {
  for (const result of currentPublicationResults((await config.ledger.load()).results)) {
    await reconcileResult(config, state, result);
  }
}

function blockingReasonKey(reason: string): string {
  return `blocked-${createHash("sha256").update(reason).digest("hex").slice(0, 16)}`;
}

export async function processDependencyCycle(config: ProcessConfig, state: DependencyWorkflowState): Promise<"processed" | "no-runnable"> {
  state.cycle++;
  await discover(config, state);
  await reconcileRecordedPublications(config, state);
  const graph = buildDependencyGraph([...state.tickets.values()], new Set(state.mergedSatisfied.keys()));
  for (const [ticketId, reason] of graph.invalidDependencies) state.blocked.set(ticketId, reason);

  for (const [ticketId, reason] of [...state.blocked]) {
    if (reason.startsWith("missing dependencies:") && !graph.missingDependencies.has(ticketId)) state.blocked.delete(ticketId);
  }
  for (const [ticketId, reason] of [...state.blocked]) {
    if (reason.startsWith("waiting for dependencies:") && state.tickets.get(ticketId)?.dependsOnTickets.every((id) => state.reviewed.has(id) || state.published.has(id) || state.mergedSatisfied.has(id))) state.blocked.delete(ticketId);
  }
  for (const [ticketId, missing] of graph.missingDependencies) {
    if (!state.blocked.has(ticketId) || state.blocked.get(ticketId)?.startsWith("missing dependencies:")) {
      state.blocked.set(ticketId, `missing dependencies: ${missing.join(", ")}`);
    }
  }
  for (const [ticketId, reason] of [...state.blocked]) {
    if (reason.startsWith("blocked by dependency ")) state.blocked.delete(ticketId);
  }
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const ticket of state.tickets.values()) {
      if (state.blocked.has(ticket.id)) continue;
      const blockedDependency = ticket.dependsOnTickets.find((id) => state.blocked.has(id));
      if (blockedDependency === undefined) continue;
      state.blocked.set(ticket.id, `blocked by dependency ${blockedDependency}: ${state.blocked.get(blockedDependency)!}`);
      propagated = true;
    }
  }
  for (const [ticketId, reason] of state.blocked) {
    const entry = state.issues.get(ticketId);
    if (entry === undefined) continue;
    if (state.withdrawn.has(ticketId) || state.retired.has(ticketId)) continue;
    const ticket = entry.ticket;
    await reportBlocked(config, ticket, reason);
    if (reason.startsWith("waiting for dependencies:") && ticket.dependsOnTickets.every((id) => {
      const dependency = state.issues.get(id);
      return state.mergedSatisfied.has(id) || state.reviewed.has(id) || state.published.has(id)
        || (!state.blocked.has(id) && (dependency?.status === "Ready for development" || dependency?.status === "In progress"));
    })) continue;
    await reportSettlement(config, ticketId, "blocked", () => config.workflow.blocked(targetOf(entry), reason, blockingReasonKey(reason)));
  }

  const completed = new Set([...state.reviewed.keys(), ...state.published]);
  const excluded = new Set([...state.blocked.keys(), ...nonSchedulableStatuses(state)]);
  const readyIds = graph.readyTicketIds(completed, excluded);
  const groups = deliveryGroups(graph, state).filter((group) => group.memberIds.some((id) => readyIds.includes(id)));
  if (groups.length === 0) return "no-runnable" as const;
  const plannerInput: PlannedGroup[] = groups.map((group) => ({
    groupId: group.id,
    tickets: group.memberIds.filter((id) => !state.reviewed.has(id)).map((id) => ({ id, title: state.tickets.get(id)!.title })),
  }));
  const selected = await planGroups({ groups: plannerInput, factoryRoot: config.factoryRoot, harness: config.harness, runAgent: config.runAgent, runId: String(state.cycle) });
  for (const planned of selected) {
    const group = groups.find((candidate) => candidate.id === planned.groupId)!;
    const deferred = new Set<string>();
    for (;;) {
      for (const [ticketId, reason] of [...state.blocked]) {
        if (reason.startsWith("waiting for dependencies:") && state.tickets.get(ticketId)?.dependsOnTickets.every((id) => state.reviewed.has(id) || state.published.has(id) || state.mergedSatisfied.has(id))) state.blocked.delete(ticketId);
      }
      const currentReady = graph
        .readyTicketIds(new Set([...state.reviewed.keys(), ...state.published]), new Set([...state.blocked.keys(), ...deferred, ...nonSchedulableStatuses(state)]))
        .filter((id) => group.memberIds.includes(id))
        .map((id) => state.tickets.get(id)!);
      if (currentReady.length === 0) break;
      const multiParentBaselines = await prepareMultiParentBaselines(group.id, currentReady, state, config);
      const runnable = currentReady.filter((ticket) => ticket.dependsOnTickets.length < 2 || multiParentBaselines.has(ticket.id));
      if (runnable.length === 0) break;
      const outcomes = await Promise.all(runnable.map(async (ticket) => ({
        id: ticket.id,
        outcome: await runTicket(ticket, state, config, multiParentBaselines.get(ticket.id) ?? baselineFor(ticket, state)),
      })));
      for (const outcome of outcomes) {
        if (outcome.outcome === "deferred") deferred.add(outcome.id);
      }
    }
    for (const ticketId of group.memberIds) {
      const ticket = state.tickets.get(ticketId)!;
      if (!state.reviewed.has(ticketId) && !state.retryable.has(ticketId) && !state.blocked.has(ticketId)) {
        const waiting = ticket.dependsOnTickets.filter((id) => !state.reviewed.has(id) && !state.published.has(id) && !state.mergedSatisfied.has(id));
        if (waiting.length > 0) state.blocked.set(ticketId, `waiting for dependencies: ${waiting.join(", ")}`);
      }
    }
    await reconcileRecordedPublications(config, state);
    await publishGroup(group.id, state, config);
  }
  return "processed" as const;
}

/** Issues whose board status is not an instruction to develop: they are never scheduled. */
function nonSchedulableStatuses(state: DependencyWorkflowState): readonly string[] {
  return [...state.issues].filter(([, entry]) => entry.status !== "Ready for development" && entry.status !== "In progress").map(([ticketId]) => ticketId);
}