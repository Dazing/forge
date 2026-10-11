import { resolve } from "node:path";
import {
  annotateBlocked,
  annotateCompletion,
  annotatePublication,
  annotateRetryable,
  inspectTicketLifecycle,
  listRelevantTicketPaths,
  listTicketPaths,
  loadTicket,
  moveTicket,
  type Ticket,
} from "../tickets/index.js";
import { runGit } from "../../infrastructure/git-provider/git.js";
import { planGroups, type PlannedGroup } from "../plan-tickets/index.js";
import { publishPullRequest } from "../publish-pull-request/index.js";
import { buildDependencyGraph, type DependencyGraph } from "./dependency-graph.js";
import { executeReviewedAttempt, type ReviewedCheckpoint } from "./execute-attempt.js";
import { integrateCandidates, type ReviewedCandidate } from "./integrate-candidates.js";
import type { ProcessConfig } from "./process-config.js";
import { logSettlementFailure, settleMetadataFailure } from "./settle-attempt.js";
import { verifyMergedPublication } from "./reconcile-publication.js";
import type { WorkspaceBaseline } from "./workspace.js";

export type PublicationFact = Readonly<{
  groupId: string;
  includedTicketIds: readonly string[];
  number: number;
  url: string;
  head: string;
  sourceSha: string;
  title: string;
  body: string;
  candidate: ReviewedCandidate;
  baseSha: string;
}>;

export interface DependencyWorkflowState {
  cycle: number;
  startupChecked: boolean;
  readonly tickets: Map<string, Ticket>;
  readonly reviewed: Map<string, ReviewedCheckpoint>;
  readonly blocked: Map<string, string>;
  readonly retryable: Map<string, string>;
  readonly blockedAnnotations: Map<string, string>;
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
    reviewed: new Map(),
    blocked: new Map(),
    retryable: new Map(),
    blockedAnnotations: new Map(),
    integrationConflicts: new Map(),
    publications: new Map(),
    groupIdsByTicket: new Map(),
    mergedSatisfied: new Map(),
  };
}

async function discover(config: ProcessConfig, state: DependencyWorkflowState): Promise<void> {
  const activePaths = new Set(await listTicketPaths(config.ticketsDir));
  const paths = state.startupChecked ? [...activePaths] : await listRelevantTicketPaths(config.ticketsDir);
  const found = new Map<string, Ticket>();
  for (const path of paths) {
    let ticket: Ticket;
    try {
      ticket = await loadTicket(path, config.gitProvider);
    } catch (error) {
      if (activePaths.has(path)) await settleMetadataFailure(path, error, config);
      continue;
    }
    const prior = found.get(ticket.id);
    if (prior !== undefined && prior.path !== ticket.path) {
      if (activePaths.has(prior.path) && activePaths.has(ticket.path)) throw new Error(`Duplicate ticket ID ${ticket.id} in ${prior.path} and ${ticket.path}.`);
      const lifecyclePath = activePaths.has(ticket.path) ? prior.path : ticket.path;
      const evidence = await inspectTicketLifecycle(lifecyclePath);
      state.blocked.set(ticket.id, `prior factory evidence requires operator reconciliation${evidence.artifactReferences.length > 0 ? `: ${evidence.artifactReferences.join(", ")}` : ""}`);
      if (activePaths.has(ticket.path)) found.set(ticket.id, ticket);
      continue;
    }
    found.set(ticket.id, ticket);
    if (!state.startupChecked) {
      const evidence = await inspectTicketLifecycle(path);
      if (!activePaths.has(path) || evidence.hasAttempt || evidence.hasCheckpoint || evidence.hasPublication) {
        const references = evidence.artifactReferences.length > 0 ? `: ${evidence.artifactReferences.join(", ")}` : "";
        state.blocked.set(ticket.id, `prior factory evidence requires operator reconciliation${references}`);
      }
    }
  }
  for (const [id, ticket] of found) {
    const checkpoint = state.reviewed.get(id);
    if (checkpoint !== undefined && checkpoint.requirementsHash !== ticket.requirementsHash) {
      state.blocked.set(id, `requirements changed after successful checkpoint; author a new ticket ID instead of reusing ${id}`);
    }
    state.tickets.set(id, ticket);
  }
  state.startupChecked = true;
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
  const parent = state.reviewed.get(parentId);
  if (parent === undefined) throw new Error(`Ticket ${ticket.id} dependency ${parentId} is not reviewed.`);
  return { sha: parent.reviewCheckpoint.checkpointSha, repositoryPath: parent.workspacePath };
}

async function runTicket(ticket: Ticket, state: DependencyWorkflowState, config: ProcessConfig, baseline?: WorkspaceBaseline): Promise<"reviewed" | "deferred" | "blocked"> {
  for (let attempt = 1; attempt <= config.ticketAttemptsPerCycle; attempt++) {
    const result = await executeReviewedAttempt(ticket, config, baseline);
    if (result.status === "failed") {
      if (!result.retryable) {
        state.blocked.set(ticket.id, `${result.stage} failed after a durable boundary; operator reconciliation required`);
        return "blocked";
      }
      if (attempt === config.ticketAttemptsPerCycle) {
        const reason = `${result.stage}: ${result.failure.stderr}`;
        try {
          await annotateRetryable(ticket.path, {
            timestamp: new Date().toISOString(),
            cycle: state.cycle,
            attemptCount: attempt,
            reason,
          });
        } catch (error) {
          await logSettlementFailure(config, ticket, result.attemptId, "retryable annotation", error);
          state.blocked.set(ticket.id, "retryable annotation failed; operator reconciliation required");
          return "blocked";
        }
        state.retryable.set(ticket.id, reason);
        return "deferred";
      }
      continue;
    }
    let current: Ticket;
    try {
      current = await loadTicket(ticket.path, config.gitProvider);
    } catch (error) {
      await logSettlementFailure(config, ticket, result.checkpoint.attemptId, "requirements recheck", error);
      state.blocked.set(ticket.id, "ticket requirements could not be rechecked after review; retained checkpoint was not adopted");
      return "blocked";
    }
    if (current.requirementsHash !== ticket.requirementsHash) {
      state.blocked.set(ticket.id, `requirements changed during attempt; retained ${result.checkpoint.workspacePath} was not adopted`);
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
    const parents = unmergedParentIds
      .map((id) => state.reviewed.get(id))
      .filter((candidate): candidate is ReviewedCheckpoint => candidate !== undefined);
    if (parents.length !== unmergedParentIds.length) continue;
    if (parents.length === 1 && mergedBaseline === undefined) {
      baselines.set(ticket.id, { sha: parents[0]!.reviewCheckpoint.checkpointSha, repositoryPath: parents[0]!.workspacePath });
      continue;
    }
    try {
      const integrated = await integrateCandidates(`${groupId}-${ticket.id}-baseline`, parents, config, mergedBaseline);
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
): Promise<void> {
  const candidate = integrated ?? await integrateCandidates(groupId, checkpoints, config);
  const includedSet = new Set<string>();
  for (const checkpoint of checkpoints) dependencyClosure(checkpoint.ticket.id, state.tickets, includedSet);
  const includedTicketIds = [...includedSet].filter((id) => state.reviewed.has(id)).sort();
  const representative = checkpoints[0]!.ticket;
  const graph = buildDependencyGraph([...state.tickets.values()]);
  const groupMembers = graph.groups.find((group) => group.memberIds.includes(representative.id))?.memberIds ?? includedTicketIds;
  const tracked = state.publications.get(groupId);
  const publicationAttemptId = `group-${groupId}-${candidate.sha.slice(0, 12)}`;
  const baseSha = (await runGit(candidate.workspacePath, ["rev-parse", `origin/${representative.baseBranch}`], "reading publication base SHA")).trim();
  const result = await publishPullRequest({
    ticket: representative,
    workspacePath: candidate.workspacePath,
    branch: candidate.branch,
    attemptId: publicationAttemptId,
    harness: config.harness,
    runAgent: config.runAgent,
    gitProvider: config.gitProvider,
    onContentComplete: (head) => config.logger.record({
      timestamp: new Date().toISOString(),
      ticketId: representative.id,
      attemptId: publicationAttemptId,
      stage: "pull-request content",
      operation: "generating group pull-request content",
      status: "completed",
      checkpointSha: head,
      changes: "unchanged",
      agentLogBasename: config.logger.agentLogBasename(`pull-request-${representative.id}-${publicationAttemptId}`),
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

  const previouslyPublishedIds = new Set([...state.publications.values()].flatMap((publication) => publication.includedTicketIds));
  state.publications.set(groupId, {
    groupId,
    includedTicketIds,
    number: result.pullRequest.number,
    url: result.pullRequest.url,
    head: result.head,
    sourceSha: result.finalSha,
    title: result.title,
    body: result.body,
    candidate,
    baseSha,
  });
  // Publication is durable before local settlement. Never publish it again because annotation or movement fails.
  const newlyIncludedIds = includedTicketIds.filter((id) => !previouslyPublishedIds.has(id));
  for (const id of newlyIncludedIds) {
    const ticket = state.tickets.get(id)!;
    try {
      await annotatePublication(ticket.path, {
        timestamp: new Date().toISOString(),
        groupId,
        includedTicketIds,
        finalSha: result.finalSha,
        pullRequestUrl: result.pullRequest.url,
      });
      await annotateCompletion(ticket.path, {
        timestamp: new Date().toISOString(),
        attemptId: publicationAttemptId,
        workspacePath: candidate.workspacePath,
        branch: result.head,
        baseBranch: ticket.baseBranch,
        finalSha: result.finalSha,
        pullRequestUrl: result.pullRequest.url,
        squashPreference: result.squashPreference,
      });
    } catch (error) {
      await logSettlementFailure(config, ticket, publicationAttemptId, "completion annotation", error);
    }
    try {
      const destination = await moveTicket(ticket.path, resolve(config.ticketsDir, "done"), publicationAttemptId);
      state.tickets.set(id, { ...ticket, path: destination });
    } catch (error) {
      await logSettlementFailure(config, ticket, publicationAttemptId, "terminal movement", error);
    }
  }
}

async function publishGroup(groupId: string, state: DependencyWorkflowState, config: ProcessConfig): Promise<void> {
  const graph = buildDependencyGraph([...state.tickets.values()]);
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
  let candidate: ReviewedCandidate;
  try {
    candidate = await integrateCandidates(groupId, leafCheckpoints, config);
  } catch (error) {
    if (leafCheckpoints.length === 1) throw error;
    for (const checkpoint of leafCheckpoints) {
      const subsetId = `${groupId}-${checkpoint.ticket.id}`;
      if (!state.publications.has(subsetId)) await publishReviewedSubset(subsetId, [checkpoint], state, config);
    }
    return;
  }
  await publishReviewedSubset(groupId, leafCheckpoints, state, config, candidate);
}

async function reconcilePublications(config: ProcessConfig, state: DependencyWorkflowState): Promise<void> {
  if (config.gitProvider.getPullRequest === undefined) return;
  for (const publication of state.publications.values()) {
    const repository = state.tickets.get(publication.includedTicketIds[0]!)!.repository;
    let remote;
    try {
      remote = await config.gitProvider.getPullRequest(repository, publication.number);
    } catch (error) {
      const reason = `pull-request reconciliation failed: ${error instanceof Error ? error.message : String(error)}`;
      for (const ticket of state.tickets.values()) {
        if (ticket.dependsOnTickets.some((id) => publication.includedTicketIds.includes(id))) state.blocked.set(ticket.id, reason);
      }
      continue;
    }
    if (remote?.state !== "merged") continue;
    if (remote.mergeResultSha === undefined) {
      for (const ticket of state.tickets.values()) {
        if (ticket.dependsOnTickets.some((id) => publication.includedTicketIds.includes(id))) {
          state.blocked.set(ticket.id, `merged pull request ${publication.number} has no verifiable merge-result commit`);
        }
      }
      continue;
    }
    try {
      const firstTicket = state.tickets.get(publication.includedTicketIds[0]!)!;
      const refreshedBaseSha = await verifyMergedPublication({
        workspacePath: publication.candidate.workspacePath,
        baseBranch: firstTicket.baseBranch,
        baseSha: publication.baseSha,
        publishedSha: publication.sourceSha,
      }, remote.mergeResultSha);
      for (const [ticketId] of state.mergedSatisfied) {
        state.mergedSatisfied.set(ticketId, { sha: refreshedBaseSha, repositoryPath: publication.candidate.workspacePath });
      }
      for (const ticketId of publication.includedTicketIds) {
        state.mergedSatisfied.set(ticketId, { sha: refreshedBaseSha, repositoryPath: publication.candidate.workspacePath });
      }
    } catch (error) {
      const reason = `merged-work verification failed for pull request ${publication.number}: ${error instanceof Error ? error.message : String(error)}`;
      for (const ticket of state.tickets.values()) {
        if (ticket.dependsOnTickets.some((id) => publication.includedTicketIds.includes(id))) state.blocked.set(ticket.id, reason);
      }
    }
  }
}

export async function processDependencyCycle(config: ProcessConfig, state: DependencyWorkflowState): Promise<void> {
  state.cycle++;
  await discover(config, state);
  await reconcilePublications(config, state);
  const graph = buildDependencyGraph([...state.tickets.values()]);

  for (const [ticketId, reason] of [...state.blocked]) {
    if (reason.startsWith("missing dependencies:") && !graph.missingDependencies.has(ticketId)) state.blocked.delete(ticketId);
  }
  for (const [ticketId, reason] of [...state.blocked]) {
    if (reason.startsWith("waiting for dependencies:") && state.tickets.get(ticketId)?.dependsOnTickets.every((id) => state.reviewed.has(id))) state.blocked.delete(ticketId);
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
    const ticket = state.tickets.get(ticketId);
    if (ticket !== undefined && state.blockedAnnotations.get(ticketId) !== reason) {
      await annotateBlocked(ticket.path, {
        timestamp: new Date().toISOString(),
        cycle: state.cycle,
        attemptCount: 0,
        reason,
        blockedBy: ticket.dependsOnTickets,
      });
      state.blockedAnnotations.set(ticketId, reason);
    }
  }

  const completed = new Set(state.reviewed.keys());
  const excluded = new Set(state.blocked.keys());
  const readyIds = graph.readyTicketIds(completed, excluded);
  const groups = deliveryGroups(graph, state).filter((group) => group.memberIds.some((id) => readyIds.includes(id)));
  if (groups.length === 0) return;
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
        if (reason.startsWith("waiting for dependencies:") && state.tickets.get(ticketId)?.dependsOnTickets.every((id) => state.reviewed.has(id))) state.blocked.delete(ticketId);
      }
      const currentReady = graph
        .readyTicketIds(new Set(state.reviewed.keys()), new Set([...state.blocked.keys(), ...deferred]))
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
        const waiting = ticket.dependsOnTickets.filter((id) => !state.reviewed.has(id));
        if (waiting.length > 0) state.blocked.set(ticketId, `waiting for dependencies: ${waiting.join(", ")}`);
      }
    }
    await reconcilePublications(config, state);
    await publishGroup(group.id, state, config);
  }
}
