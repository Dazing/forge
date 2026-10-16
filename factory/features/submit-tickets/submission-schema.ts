import { z } from "zod";

// Durable local record of one submitted ticket (plan §3 D2/D3/D11): the sidecar is the client's
// only memory of which remote issue carries which source hash, and the operation key that marks
// its feedback comment. Credentials never appear in it.

/** Format of every runner-owned operation key: `factory:<kind>:<subject>:<detail>`; mirrors the coordinator's key contract so one effect is recognisable from either side. */
export const OPERATION_KEY = /^factory:[a-z][a-z-]*:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Length of the source-hash prefix that makes one submission comment key unique per ticket content. */
export const SOURCE_HASH_KEY_LENGTH = 12;

/** Build the operation key for one ticket's submission comment; a source-hash prefix keeps a content change distinct. */
export function submissionOperationKey(ticketId: string, sourceHash: string): string {
  const key = `factory:comment:${ticketId}:${sourceHash.slice(0, SOURCE_HASH_KEY_LENGTH)}`;
  if (!OPERATION_KEY.test(key)) throw new Error(`Operation key ${JSON.stringify(key)} has an unsafe ticket ID or source hash.`);
  return key;
}

/** The runner-owned HTML comment that marks a comment as belonging to one operation key. */
export function commentMarker(key: string): string {
  return `<!-- ${key} -->`;
}

/** Version tag of the sidecar record shape; readers reject anything else. */
export const SUBMISSION_STATE_VERSION = 1;

/** The last comment the client posted for one ticket, identified by its operation key. */
export const submissionCommentSchema = z.object({
  id: z.number().int().positive(),
  url: z.string().min(1),
  marker: z.string().min(1),
  sourceHash: z.string().length(64),
  postedAt: z.string().min(1),
}).strict();

/** One `<ticket-stem>.submission.json` sidecar: exact remote identity plus the hashes it carries. */
export const submissionRecordSchema = z.object({
  version: z.literal(SUBMISSION_STATE_VERSION),
  backlogRepository: z.string().min(1),
  projectId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueNodeId: z.string().min(1),
  issueUrl: z.string().min(1),
  sourceHash: z.string().length(64),
  requirementsHash: z.string().length(64),
  submittedAt: z.string().min(1),
  lastComment: submissionCommentSchema,
}).strict();

export type SubmissionRecord = Readonly<z.infer<typeof submissionRecordSchema>>;
export type SubmissionComment = Readonly<z.infer<typeof submissionCommentSchema>>;

/** Sidecar path for one ticket source: beside the file, named after its stem. */
export function submissionStatePath(sourcePath: string): string {
  const boundary = Math.max(sourcePath.lastIndexOf("/"), sourcePath.lastIndexOf("\\"));
  const stem = boundary === -1 ? sourcePath : sourcePath.slice(boundary + 1);
  const withoutExtension = /\.(md|markdown)$/i.test(stem) ? stem.replace(/\.(md|markdown)$/i, "") : stem;
  return `${sourcePath.slice(0, boundary + 1)}${withoutExtension}.submission.json`;
}

/** Parse one sidecar body; an unparseable body, a non-object, an unrecognised field, a missing field, or a version mismatch names the sidecar path. */
export function parseSubmissionRecord(sidecarPath: string, text: string): SubmissionRecord {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`Submission state ${sidecarPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error(`Submission state ${sidecarPath} must be a JSON object; found ${Array.isArray(decoded) ? "an array" : typeof decoded}.`);
  }
  const validated = submissionRecordSchema.safeParse(decoded);
  if (!validated.success) {
    const detail = validated.error.issues
      .map((issue) => issue.code === "unrecognized_keys"
        ? `unrecognised ${issue.path.join(".") || "field"}: ${issue.keys.join(", ")}`
        : `${issue.path.join(".") || "<record>"} ${issue.message}`)
      .join("; ");
    throw new Error(`Submission state ${sidecarPath} is not a usable v${SUBMISSION_STATE_VERSION} record: ${detail}`);
  }
  return validated.data;
}

/** Per-ticket submission outcome; `reason` is redacted before it reaches this type. */
export type SubmissionOutcome = "created" | "updated" | "unchanged" | "failed";

export type SubmissionEntry = Readonly<{
  source: string;
  ticketId: string;
  outcome: SubmissionOutcome;
  issueNumber?: number;
  issueUrl?: string;
  status?: string;
  reason?: string;
}>;

export type SubmissionTotals = Readonly<{
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
}>;

/** The whole batch result: `ok` is true only when no ticket failed and no gate stopped the run. */
export type SubmissionResult = Readonly<{
  ok: boolean;
  entries: readonly SubmissionEntry[];
  totals: SubmissionTotals;
}>;

/** Count one outcome per entry; the totals line is derived, never accumulated separately. */
export function submissionTotals(entries: readonly SubmissionEntry[]): SubmissionTotals {
  return {
    created: entries.filter((entry) => entry.outcome === "created").length,
    updated: entries.filter((entry) => entry.outcome === "updated").length,
    unchanged: entries.filter((entry) => entry.outcome === "unchanged").length,
    failed: entries.filter((entry) => entry.outcome === "failed").length,
  };
}
