import type { GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";
import { parseTicketSource, type Ticket } from "./ticket.js";

// Remote backlog identity: one issue body carries exactly one complete authored ticket source.
// The submit CLI parses the same source with `parseTicketSource`, so a submitted file and the
// issue it created validate identically. Lifecycle transitions themselves belong to the features
// that own scheduling and ingestion, never to this leaf.

/** The six configured backlog workflow states in board order. These are operator-created Project
 * option names, not GitHub defaults; a missing option is a configuration failure, never `Ready`. */
export const BACKLOG_STATUSES = ["Staging", "Ready for development", "In progress", "In review", "Done", "Blocked"] as const;

/** One configured backlog workflow state name. */
export type BacklogStatusName = (typeof BACKLOG_STATUSES)[number];

/** Remote identity of the issue that carries one authored ticket. `backlogRepository` is the
 * `owner/repository` that scopes ticket-ID uniqueness; it is not the ticket's target code repository. */
export type IssueIdentity = Readonly<{
  backlogRepository: string;
  number: number;
  nodeId: string;
  url: string;
}>;

/** One issue body validated as a complete authored ticket source, with the parsed ticket and the
 * requirements hash that authorizes work on it. The authored source is retained verbatim for
 * materialization, so scheduling reads the graph fields without a second parse. */
export type AuthoredIssueSnapshot = Readonly<{
  identity: IssueIdentity;
  source: string;
  requirementsHash: string;
  ticket: Ticket;
}>;

/** Validate one issue body as a ticket. Failures carry the issue URL as their origin so a remote
 * metadata problem is diagnosable without a filesystem path. */
export function parseAuthoredIssueSnapshot(identity: IssueIdentity, source: string, providers: GitProviderRegistry): AuthoredIssueSnapshot {
  const ticket = parseTicketSource(source, providers, identity.url);
  return { identity, source, requirementsHash: ticket.requirementsHash, ticket };
}
