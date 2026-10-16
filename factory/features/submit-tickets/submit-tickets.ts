import { redactSecrets } from "../../shared/redact-secret.js";
import type { GitProvider, GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";
import { BacklogConfigurationError, type BacklogIssue, type BacklogStatusField, type GitHubBacklog } from "../../infrastructure/github-backlog/index.js";
import { BACKLOG_STATUSES, parseTicketSource, type BacklogStatusName, type Ticket } from "../tickets/index.js";
import { commentMarker, submissionTotals, SUBMISSION_STATE_VERSION, submissionOperationKey, submissionStatePath, type SubmissionEntry, type SubmissionRecord, type SubmissionResult } from "./submission-schema.js";
import { acquireSubmissionLock, readSubmissionRecord, releaseSubmissionLock, submissionRoot, writeSubmissionRecord } from "./submission-state.js";
import { expandTicketPaths, readTicketSources, submissionProviderRegistry, validateBatch, type SourceProblem, type ValidatedSource } from "./submission-sources.js";

// Ingestion policy for `npm run tickets -- submit` (plan §3 D3): validate the whole batch, then apply
// the smallest effect per ticket — create, update, attach, Staging, verify, Ready — plus one keyed
// feedback comment. Statuses beyond Staging/Ready for development are never written here; the server
// owns everything after Ready, and no credential ever reaches a report, comment, or sidecar.

/** The only two statuses submission may set; everything else is human- or server-owned. */
export const STAGING: BacklogStatusName = "Staging";
export const READY_FOR_DEVELOPMENT: BacklogStatusName = "Ready for development";

/** Gate failure that stops the run with zero writes: repository/Project privacy, identity, scope, Project access. */
export class SubmissionGateError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? {} : { cause });
    this.name = "SubmissionGateError";
  }
}

/** Everything `submitTickets` needs; the host constructs the transport and the provider. */
export type SubmitTicketsInput = Readonly<{
  paths: readonly string[];
  backlog: GitHubBacklog;
  provider: GitProvider;
  cwd: string;
  repositoryOverride?: string;
  projectIdOverride?: string;
  dryRun: boolean;
  json: boolean;
  now?: () => Date;
  log?: (line: string) => void;
}>;

/** One backlog issue that carries one authored ticket. */
export type RemoteTicket = Readonly<{ issue: BacklogIssue; ticketId: string; requirementsHash: string }>;

/** The resolved gates: confirmed private backlog, resolved Status options, and the current issue set. */
export type SubmissionGates = Readonly<{
  repository: string;
  projectId: string;
  field: BacklogStatusField;
  stagingOptionId: string;
  readyOptionId: string;
  issues: readonly BacklogIssue[];
  remote: ReadonlyMap<string, RemoteTicket>;
}>;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Turn a transport configuration failure into a run-stopping diagnosis naming the missing capability. */
function gateFailure(operation: string, scope: "repo" | "project", error: unknown, redact: (text: string) => string): SubmissionGateError {
  if (error instanceof BacklogConfigurationError) {
    return new SubmissionGateError(
      `Backlog ${operation} failed: FORGE_BACKLOG_TOKEN is missing the classic \`${scope}\` scope${scope === "project" ? " required for Projects v2; fine-grained tokens cannot reach a Project" : " required for private issues"} and cannot authorize it. Zero writes. ${redact(toMessage(error))}`,
      error,
    );
  }
  return new SubmissionGateError(`Backlog ${operation} failed: ${redact(toMessage(error))}. Zero writes.`, error);
}

/** Read every gate before any write: private repository, matching identity, usable private Project, current issues. */
export async function readSubmissionGates(input: SubmitTicketsInput, redact: (text: string) => string): Promise<SubmissionGates> {
  const backlog = input.backlog;
  const repository = input.repositoryOverride ?? backlog.repository;
  const projectId = input.projectIdOverride ?? backlog.projectId;

  let identity: { private: boolean; fullName: string };
  try {
    identity = await backlog.validateRepository();
  } catch (error) {
    throw gateFailure("repository gate", "repo", error, redact);
  }
  if (identity.fullName.toLowerCase() !== repository.toLowerCase()) {
    throw new SubmissionGateError(`Backlog repository mismatch: the run targets ${repository}, the token reports ${identity.fullName}. Zero writes.`);
  }
  if (!identity.private) {
    throw new SubmissionGateError(`Backlog repository ${identity.fullName} is public, so ticket content would be published. Zero writes.`);
  }

  let field: BacklogStatusField;
  try {
    field = await backlog.validateProject(BACKLOG_STATUSES);
  } catch (error) {
    throw gateFailure("Project gate", "project", error, redact);
  }
  const stagingOptionId = field.options.find((option) => option.name === STAGING)?.optionId;
  if (stagingOptionId === undefined) {
    throw new SubmissionGateError(`Backlog Project ${projectId} has no \`${STAGING}\` Status option, so a submission cannot be staged. Zero writes.`);
  }
  const readyOptionId = field.options.find((option) => option.name === READY_FOR_DEVELOPMENT)?.optionId;
  if (readyOptionId === undefined) {
    throw new SubmissionGateError(`Backlog Project ${projectId} has no \`${READY_FOR_DEVELOPMENT}\` Status option, so a submission cannot be released. Zero writes.`);
  }

  const issues = await backlog.listIssues();
  const remote = await backlogTicketIds(backlog, input.provider, issues);
  return { repository, projectId, field, stagingOptionId, readyOptionId, issues, remote };
}

/** Index every ticket ID already present in the backlog by validated issue body — never by title or filename. */
export async function backlogTicketIds(backlog: GitHubBacklog, provider: GitProvider, issues: readonly BacklogIssue[]): Promise<ReadonlyMap<string, RemoteTicket>> {
  const registry = submissionProviderRegistry(provider);
  const found = new Map<string, RemoteTicket>();
  for (const issue of issues) {
    // Only issue bodies that validate as complete authored tickets are backlog members.
    const parsed = parseIssueTicket(issue, registry);
    if (parsed !== undefined) found.set(parsed.id, { issue, ticketId: parsed.id, requirementsHash: parsed.requirementsHash });
  }
  return found;
}

/** Parse one issue body as an authored ticket; anything else is not a backlog member. */
function parseIssueTicket(issue: BacklogIssue, registry: GitProviderRegistry): Ticket | undefined {
  try {
    return parseTicketSource(issue.body, registry, issue.url);
  } catch {
    return undefined;
  }
}

/** Run the whole submission: gates, batch validation, then one smallest effect per ticket. */
export async function submitTickets(input: SubmitTicketsInput): Promise<SubmissionResult> {
  const log = input.log ?? (() => {});
  const now = input.now ?? (() => new Date());
  const redact = (text: string) => redactSecrets([...input.provider.secrets(), ...input.backlog.secrets], text);
  const paths = await expandTicketPaths(input.paths, input.cwd);
  const lockPath = await acquireSubmissionLock(submissionRoot(paths, input.cwd), process.pid, now().toISOString());
  try {
    const gates = await readSubmissionGates(input, redact);
    const { files, problems: readProblems } = await readTicketSources(paths);
    const validation = validateBatch({
      files,
      providers: submissionProviderRegistry(input.provider),
      provider: input.provider,
      ...(input.repositoryOverride === undefined ? {} : { repositoryOverride: input.repositoryOverride }),
      knownTicketIds: new Map([...gates.remote].map(([ticketId, remote]) => [ticketId, remote.issue.number])),
    });
    const problems: SourceProblem[] = [...readProblems, ...validation.problems];
    if (problems.length > 0) {
      const entries = problems.map((problem) => ({
        source: problem.path ?? input.paths.join(", "),
        ticketId: "",
        outcome: "failed" as const,
        reason: redact(problem.reason),
      }));
      log(`${entries.length} ticket(s) rejected before any write`);
      return { ok: false, entries, totals: submissionTotals(entries) };
    }

    const batchIds = new Set(validation.sources.map((source) => source.ticket.id));
    const entries: SubmissionEntry[] = [];
    try {
      for (const source of validation.sources) {
        entries.push(await submitValidated(input, source, gates, batchIds, redact, now));
      }
    } catch (error) {
      // A gate that fails mid-batch stops every later ticket; the sidecars already written are the record.
      for (const entry of entries) log(`${entry.outcome} ${entry.ticketId} ${entry.issueUrl ?? entry.source}`);
      throw error;
    }
    return { ok: entries.every((entry) => entry.outcome !== "failed"), entries, totals: submissionTotals(entries) };
  } finally {
    await releaseSubmissionLock(lockPath);
  }
}

/** GitHub's comment ceiling; the client refuses to build a feedback body above it. */
const MAX_COMMENT_LENGTH = 65536;

/** The issue that carries one ticket (if any) and the body effect submission will apply to it. */
type TicketTarget = Readonly<{ remote: RemoteTicket | undefined; effect: "created" | "updated" }>;

/** Locate the issue carrying this ticket: the sidecar number first, then the exact ticket-ID scan of the backlog. */
export async function findTicketTarget(backlog: GitHubBacklog, registry: GitProviderRegistry, source: ValidatedSource, sidecar: SubmissionRecord | undefined, gates: SubmissionGates): Promise<TicketTarget> {
  if (sidecar !== undefined) {
    if (sidecar.backlogRepository.toLowerCase() !== gates.repository.toLowerCase() || sidecar.projectId !== gates.projectId) {
      throw new Error(`Sidecar for ${source.path} targets ${sidecar.backlogRepository} / ${sidecar.projectId}, not ${gates.repository} / ${gates.projectId}.`);
    }
    const expectedMarker = commentMarker(submissionOperationKey(source.ticket.id, sidecar.sourceHash));
    if (sidecar.lastComment.marker !== expectedMarker || sidecar.lastComment.sourceHash !== sidecar.sourceHash) {
      throw new Error(`Sidecar for ${source.path} does not identify ticket ${source.ticket.id}.`);
    }
    const issue = await backlog.getIssue(sidecar.issueNumber);
    if (issue === undefined || issue.number !== sidecar.issueNumber || issue.nodeId !== sidecar.issueNodeId) {
      throw new Error(`Sidecar for ${source.path} does not match the exact issue number and node identity.`);
    }
    const carrier = parseIssueTicket(issue, registry);
    if (carrier === undefined || carrier.id !== source.ticket.id) {
      throw new Error(`Sidecar for ${source.path} points at issue ${issue.number}, which does not carry validated ticket ${source.ticket.id}.`);
    }
    return { remote: { issue, ticketId: carrier.id, requirementsHash: carrier.requirementsHash }, effect: "updated" };
  }
  const scanned = gates.remote.get(source.ticket.id);
  return { remote: scanned, effect: scanned === undefined ? "created" : "updated" };
}

/** Deterministic, credential-free feedback body: the operation-key marker plus the facts this submission established. */
export function submissionCommentBody(facts: Readonly<{
  marker: string;
  ticketId: string;
  issueUrl: string;
  repository: string;
  baseBranch: string;
  dependsOn: readonly string[];
  sourceHash: string;
  requirementsHash: string;
}>): string {
  return [
    facts.marker,
    `- Ticket: ${facts.ticketId}`,
    `- Issue: ${facts.issueUrl}`,
    `- Repository: ${facts.repository}`,
    `- Base branch: ${facts.baseBranch}`,
    `- Depends on: ${facts.dependsOn.length === 0 ? "none" : facts.dependsOn.join(", ")}`,
    `- Source hash: ${facts.sourceHash}`,
    `- Requirements hash: ${facts.requirementsHash}`,
  ].join("\n");
}

/** Apply the smallest effect that makes one validated source the content of its backlog issue. */
export async function submitValidated(
  input: SubmitTicketsInput,
  source: ValidatedSource,
  gates: SubmissionGates,
  batchIds: ReadonlySet<string>,
  redact: (text: string) => string,
  now: () => Date,
): Promise<SubmissionEntry> {
  const log = input.log ?? (() => {});
  const { backlog } = input;
  const { ticket } = source;
  const base = { source: source.path, ticketId: ticket.id };
  const failed = (reason: string, issue: BacklogIssue | undefined): SubmissionEntry => ({
    ...base,
    outcome: "failed",
    ...(issue === undefined ? {} : { issueNumber: issue.number, issueUrl: issue.url }),
    reason: redact(reason),
  });

  const registry = submissionProviderRegistry(input.provider);
  let target: TicketTarget;
  let sidecar: SubmissionRecord | undefined;
  let status: string | undefined;
  try {
    sidecar = await readSubmissionRecord(source.path);
    target = await findTicketTarget(backlog, registry, source, sidecar, gates);
    if (target.remote !== undefined) {
      status = (await backlog.findProjectItem(target.remote.issue.nodeId))?.status?.name;
    }
  } catch (error) {
    return failed(toMessage(error), undefined);
  }
  const remote = target.remote;
  const exactSource = remote !== undefined && remote.issue.body === source.source;
  if (remote !== undefined && status !== STAGING && !exactSource) {
    return failed(`Refusing to mutate ${remote.issue.url}: Project Status is ${status ?? "not set"}, and only \`${STAGING}\` accepts a resubmission.`, remote.issue);
  }
  // Exact authored bytes establish a replay, not permission to edit a claimed ticket.
  // A missing attachment/status is repairable; a later status must never be demoted.
  const needsReady = remote === undefined || status === undefined || status === STAGING;
  const marker = commentMarker(submissionOperationKey(ticket.id, ticket.sourceHash));
  let issue = remote?.issue;
  try {
    const comments = remote === undefined ? [] : await backlog.listComments(remote.issue.number);
    const posted = comments.find((comment) => comment.body.includes(marker));
    if (remote !== undefined && !needsReady && sidecar !== undefined && sidecar.sourceHash === ticket.sourceHash
      && sidecar.requirementsHash === ticket.requirementsHash && posted !== undefined
      && sidecar.lastComment.id === posted.id && sidecar.lastComment.url === posted.url) {
      return { ...base, outcome: "unchanged", issueNumber: remote.issue.number, issueUrl: remote.issue.url };
    }
    const finalStatus = needsReady ? READY_FOR_DEVELOPMENT : status;
    const planned = { outcome: target.effect, ...(remote === undefined ? {} : { issueNumber: remote.issue.number, issueUrl: remote.issue.url }) };
    if (input.dryRun) {
      log(`${target.effect} ${ticket.id} (dry run)`);
      return { ...base, ...planned, ...(finalStatus === undefined ? {} : { status: finalStatus }) };
    }

    const accepted = remote === undefined
      ? await backlog.createIssue(ticket.title, source.source)
      : exactSource ? remote.issue : await backlog.updateIssueBody(remote.issue.number, source.source, remote.issue.revision);
    if (needsReady) await backlog.setProjectStatus(accepted.nodeId, gates.stagingOptionId);

    const readBack = await backlog.getIssue(accepted.number);
    if (readBack === undefined || readBack.number !== accepted.number || readBack.nodeId !== accepted.nodeId || readBack.body !== source.source) {
      throw new Error(`Issue ${accepted.number} body or identity read-back is not the submitted source; no further writes.`);
    }
    issue = readBack;
    for (const dependency of ticket.dependsOnTickets) {
      if (!gates.remote.has(dependency) && !batchIds.has(dependency)) {
        throw new Error(`Ticket ${ticket.id} dependency ${dependency} does not resolve in the backlog; Ready was not set.`);
      }
    }
    const privacy = await backlog.validateRepository();
    if (!privacy.private || privacy.fullName.toLowerCase() !== gates.repository.toLowerCase()) {
      throw new SubmissionGateError(`Backlog repository ${privacy.fullName} became public or changed identity before submission completed; no further writes.`);
    }
    if (needsReady) await backlog.setProjectStatus(issue.nodeId, gates.readyOptionId);

    const body = submissionCommentBody({
      marker,
      ticketId: ticket.id,
      issueUrl: issue.url,
      repository: ticket.repository,
      baseBranch: ticket.baseBranch,
      dependsOn: ticket.dependsOnTickets,
      sourceHash: ticket.sourceHash,
      requirementsHash: ticket.requirementsHash,
    });
    if (body.length > MAX_COMMENT_LENGTH) {
      return failed(`Submission comment for ${ticket.id} is ${body.length} characters, above the ${MAX_COMMENT_LENGTH} limit.`, readBack);
    }
    const comment = posted ?? await backlog.createComment(issue.number, redact(body));
    const stamp = now().toISOString();
    await writeSubmissionRecord(submissionStatePath(source.path), {
      version: SUBMISSION_STATE_VERSION,
      backlogRepository: gates.repository,
      projectId: gates.projectId,
      issueNumber: issue.number,
      issueNodeId: issue.nodeId,
      issueUrl: issue.url,
      sourceHash: ticket.sourceHash,
      requirementsHash: ticket.requirementsHash,
      submittedAt: stamp,
      lastComment: { id: comment.id, url: comment.url, marker, sourceHash: ticket.sourceHash, postedAt: stamp },
    });
    log(`${target.effect} ${ticket.id} #${issue.number} ${issue.url}`);
    return { ...base, outcome: target.effect, issueNumber: issue.number, issueUrl: issue.url, ...(finalStatus === undefined ? {} : { status: finalStatus }) };
  } catch (error) {
    if (error instanceof SubmissionGateError) throw error;
    if (error instanceof BacklogConfigurationError) throw gateFailure(`submitting ticket ${ticket.id}`, "project", error, redact);
    return failed(toMessage(error), issue);
  }
}
