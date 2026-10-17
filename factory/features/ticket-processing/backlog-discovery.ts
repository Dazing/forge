import { parse as parseYaml } from "yaml";
import type { BacklogIssue, GitHubBacklog } from "../../infrastructure/github-backlog/index.js";
import type { GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";
import {
  parseAuthoredIssueSnapshot,
  TicketMetadataError,
  type AuthoredIssueSnapshot,
  type BacklogStatusName,
  type IssueIdentity,
  type Ticket,
} from "../tickets/index.js";

// Server-side discovery (D3): the backlog, not a directory, is the ticket source. One cycle reads
// every issue and the Project board once, parses issue bodies with the same parser the submission
// client used, and separates schedulable tickets from the evidence an operator must reconcile.

/** The board status names that make an issue eligible for factory work. */
const SCHEDULABLE: readonly BacklogStatusName[] = ["Ready", "In progress"];

/** One parsed issue with its board position. */
export type BacklogTicket = Readonly<{
  snapshot: AuthoredIssueSnapshot;
  ticket: Ticket;
  status: BacklogStatusName | undefined;
}>;

/** An issue whose body is not a valid ticket, reported by issue identity, never by a file path. */
export type DiscoveryFailure = Readonly<{ issueNumber: number; issueUrl: string; reason: string }>;

/** Ticket IDs declared by more than one open issue; none of them may be scheduled. */
export type DuplicateIdentity = Readonly<{ ticketId: string; issueNumbers: readonly number[] }>;

export type BacklogDiscovery = Readonly<{
  tickets: readonly BacklogTicket[];
  failures: readonly DiscoveryFailure[];
  duplicates: readonly DuplicateIdentity[];
  /** Open issues with no Project item, so the board has expressed no scheduling intent. */
  unboarded: readonly number[];
}>;

/** The target repository one authored source declares, when its front matter is readable enough to route it to a provider. */
export function declaredRepository(source: string): string | undefined {
  const frontMatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?/.exec(source);
  if (frontMatter === null) return undefined;
  let data: unknown;
  try {
    data = parseYaml(frontMatter[1]!);
  } catch {
    return undefined;
  }
  const repository = (data as { repository?: unknown } | null)?.repository;
  return typeof repository === "string" && repository.trim().length > 0 ? repository.trim() : undefined;
}

function identityOf(issue: BacklogIssue, backlogRepository: string): IssueIdentity {
  return { backlogRepository, number: issue.number, nodeId: issue.nodeId, url: issue.url };
}

function reasonOf(error: unknown): string {
  if (error instanceof TicketMetadataError) return `${error.failure.operation}: ${error.failure.stderr}`;
  return error instanceof Error ? error.message : String(error);
}

/** Read the backlog once: every open issue parsed as a ticket, with board status and the evidence that blocks scheduling. */
export async function discoverBacklogTickets(backlog: GitHubBacklog, providers: GitProviderRegistry): Promise<BacklogDiscovery> {
  const [issues, items] = await Promise.all([backlog.listIssues(), backlog.listProjectItems()]);
  const statusByNumber = new Map(items.map((item) => [item.issueNumber, item.status?.name]));
  const tickets: BacklogTicket[] = [];
  const failures: DiscoveryFailure[] = [];
  const unboarded: number[] = [];
  const byTicketId = new Map<string, number[]>();

  for (const issue of [...issues].sort((left, right) => left.number - right.number)) {
    if (issue.state === "closed") continue;
    const identity = identityOf(issue, backlog.repository);
    const declared = declaredRepository(issue.body);
    if (declared === undefined) {
      failures.push({ issueNumber: issue.number, issueUrl: issue.url, reason: "the issue body declares no target repository" });
      continue;
    }
    let provider;
    try {
      provider = providers.resolve(declared);
    } catch (error) {
      failures.push({ issueNumber: issue.number, issueUrl: issue.url, reason: reasonOf(error) });
      continue;
    }
    let snapshot: AuthoredIssueSnapshot;
    try {
      snapshot = parseAuthoredIssueSnapshot(identity, issue.body, providers);
    } catch (error) {
      failures.push({ issueNumber: issue.number, issueUrl: issue.url, reason: reasonOf(error) });
      continue;
    }
    tickets.push({ snapshot, ticket: snapshot.ticket, status: statusByNumber.get(issue.number) as BacklogStatusName | undefined });
    if (!items.some((item) => item.issueNumber === issue.number)) unboarded.push(issue.number);
    byTicketId.set(snapshot.ticket.id, [...(byTicketId.get(snapshot.ticket.id) ?? []), issue.number]);
  }

  const duplicates: DuplicateIdentity[] = [...byTicketId]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([ticketId, numbers]) => ({ ticketId, issueNumbers: numbers }));
  const duplicated = new Set(duplicates.map((duplicate) => duplicate.ticketId));
  return {
    tickets: tickets.filter((ticket) => !duplicated.has(ticket.ticket.id)),
    failures,
    duplicates,
    unboarded,
  };
}

/** Issues eligible for work: on the board with a scheduling status, parsed, and uniquely identified. */
export function schedulable(discovery: BacklogDiscovery): readonly BacklogTicket[] {
  return discovery.tickets.filter((ticket) => ticket.status !== undefined && SCHEDULABLE.includes(ticket.status));
}

/** Issues the runner previously claimed; a restart must reconcile them before starting anything new. */
export function claimed(discovery: BacklogDiscovery): readonly BacklogTicket[] {
  return discovery.tickets.filter((ticket) => ticket.status === "In progress");
}
