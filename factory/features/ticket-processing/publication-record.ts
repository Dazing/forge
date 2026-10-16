import { z } from "zod";
import type { MergeStrategy, SquashPreference } from "../../infrastructure/git-provider/git-provider.js";

// Runner-owned operation identity for every backlog side effect (D11) and the durable publication
// record (D10). Keys are deterministic so a restart can recognise effects it already performed;
// the record carries exactly the facts needed to reconcile a publication against provider state.

/** Format of every runner-owned operation key: `factory:<kind>:<subject>:<detail>`, usable verbatim as a file name and as a comment marker. */
export const OPERATION_KEY = /^factory:[a-z][a-z-]*:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Canonical key segment: URLs, paths, and reasons collapse to the key alphabet, so identity depends on content, not punctuation. */
function segment(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^[-.]+|[-.]+$/g, "");
}

/** Build the one operation key for a backlog effect, rejecting a subject or detail with no key-safe content. */
export function operationKey(kind: "comment" | "start" | "failure" | "publication" | "preservation" | "settlement", subject: string, detail: string): string {
  const key = `factory:${kind}:${segment(subject)}:${segment(detail)}`;
  if (!OPERATION_KEY.test(key)) throw new Error(`Operation key ${JSON.stringify(key)} has an unsafe kind, subject, or detail.`);
  return key;
}

/** The runner-owned HTML comment that marks a comment as belonging to one operation key. */
export function commentMarker(key: string): string {
  return `<!-- ${key} -->`;
}

/** Version tag of the durable publication record shape; readers reject anything else. */
export const PUBLICATION_RECORD_VERSION = 1;

/** One publication side-effect intent, durable before any push or provider write. Credentials never appear in it. */
export const publicationIntentSchema = z.object({
  version: z.literal(PUBLICATION_RECORD_VERSION),
  operationKey: z.string().regex(OPERATION_KEY),
  groupId: z.string().min(1),
  provider: z.enum(["github", "azure-devops"]),
  repository: z.string().min(1),
  baseBranch: z.string().min(1),
  baseSha: z.string().min(1),
  head: z.string().min(1),
  sourceSha: z.string().min(1),
  title: z.string(),
  body: z.string(),
  mergeStrategy: z.literal("squash"),
  included: z.array(z.object({
    ticketId: z.string().min(1),
    issueNumber: z.number().int().positive(),
    issueNodeId: z.string().min(1),
    requirementsHash: z.string().length(64),
  }).strict()).min(1),
  recordedAt: z.string().min(1),
}).strict();

/** The provider identity returned for an intent, durable before any issue settlement. */
export const publicationResultSchema = publicationIntentSchema.extend({
  pullRequestNumber: z.number().int().positive(),
  pullRequestUrl: z.string().url().min(1),
  squashPreference: z.enum(["configured", "unsupported"]),
  publishedAt: z.string().min(1),
}).strict();

export type PublicationIntent = Readonly<z.infer<typeof publicationIntentSchema>>;
export type PublicationResult = Readonly<z.infer<typeof publicationResultSchema>>;

/** Exact provider identity lookup inputs for an uncertain create (D10). */
export type PublicationLookup = Readonly<{
  repository: string;
  head: string;
  base: string;
  sourceSha: string;
}>;

/** The merge-method preference the runner always requests; recorded so reconciliation can compare it. */
export const REQUESTED_MERGE_STRATEGY: MergeStrategy = "squash";
