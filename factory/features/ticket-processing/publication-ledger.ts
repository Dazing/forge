import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { BACKLOG_STATUSES } from "../tickets/index.js";
import { OPERATION_KEY, publicationIntentSchema, publicationResultSchema, type PublicationIntent, type PublicationResult } from "./publication-record.js";

// Minimal durable external-side-effect state (D10): `.factory-state/` under the factory root, one
// atomic versioned JSON file per record. It exists so a restarted process can reconcile facts it
// already caused (a pushed branch, a created pull request, an issue write) instead of guessing.
// It never resumes stage execution, never stores credentials, and never owns graph scheduling.

/** Directory holding durable publication and settlement records, ignored by Git. */
export const STATE_DIRECTORY = ".factory-state";

const INTENT_PREFIX = "publication-intent-";
const RESULT_PREFIX = "publication-result-";
const SETTLEMENT_PREFIX = "settlement-";

const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One Project status transition or issue closure that a restart must replay without repeating code publication. */
export const pendingSettlementSchema = z.object({
  version: z.literal(1),
  operationKey: z.string().regex(OPERATION_KEY),
  kind: z.enum(["status", "close"]),
  subject: z.string().regex(SUBJECT),
  status: z.enum(BACKLOG_STATUSES).optional(),
  ticketId: z.string().min(1),
  issueNumber: z.number().int().positive(),
  issueNodeId: z.string().min(1),
  detail: z.string(),
  recordedAt: z.string().min(1),
}).strict();

export type PendingSettlement = Readonly<z.infer<typeof pendingSettlementSchema>>;

/** One persisted file the runner could not decode; its work is blocked for operator reconciliation. */
export type CorruptRecord = Readonly<{ file: string; reason: string }>;

export type LedgerSnapshot = Readonly<{
  intents: readonly PublicationIntent[];
  results: readonly PublicationResult[];
  settlements: readonly PendingSettlement[];
  corrupt: readonly CorruptRecord[];
}>;

const INTENT_FILE = (key: string) => `${INTENT_PREFIX}${key}.json`;
const RESULT_FILE = (key: string) => `${RESULT_PREFIX}${key}.json`;
const SETTLEMENT_FILE = (key: string) => `${SETTLEMENT_PREFIX}${key}.json`;

function recordFile(key: string, prefix: string): string {
  if (!OPERATION_KEY.test(key)) throw new Error(`Durable record key ${JSON.stringify(key)} is not a runner operation key.`);
  return `${prefix}${key}.json`;
}

/**
 * Coordinator-owned durable records for external side effects. Every write is a same-directory
 * temp file plus rename, so a crash leaves the previous record intact and never a partial one.
 */
export class PublicationLedger {
  private constructor(readonly directory: string) {}

  static open(factoryRoot: string): PublicationLedger {
    return new PublicationLedger(resolve(factoryRoot, STATE_DIRECTORY));
  }

  async load(): Promise<LedgerSnapshot> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    const intents: PublicationIntent[] = [];
    const results: PublicationResult[] = [];
    const settlements: PendingSettlement[] = [];
    const corrupt: CorruptRecord[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      let value: unknown;
      try {
        value = JSON.parse(await readFile(resolve(this.directory, name), "utf8"));
      } catch (error) {
        corrupt.push({ file: name, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      const issue = (error: z.ZodError) => error.issues.map((detail) => `${detail.path.join(".") || "<record>"} ${detail.message}`).join("; ");
      if (name.startsWith(INTENT_PREFIX)) {
        const parsed = publicationIntentSchema.safeParse(value);
        if (parsed.success) intents.push(parsed.data);
        else corrupt.push({ file: name, reason: issue(parsed.error) });
      } else if (name.startsWith(RESULT_PREFIX)) {
        const parsed = publicationResultSchema.safeParse(value);
        if (parsed.success) results.push(parsed.data);
        else corrupt.push({ file: name, reason: issue(parsed.error) });
      } else if (name.startsWith(SETTLEMENT_PREFIX)) {
        const parsed = pendingSettlementSchema.safeParse(value);
        if (parsed.success) settlements.push(parsed.data);
        else corrupt.push({ file: name, reason: issue(parsed.error) });
      } else {
        corrupt.push({ file: name, reason: "unrecognised record kind" });
      }
    }
    return { intents, results, settlements, corrupt };
  }

  /** Durably record one side-effect intent before any push or provider write. */
  writeIntent(intent: PublicationIntent): Promise<void> {
    return this.write(recordFile(intent.operationKey, INTENT_PREFIX), intent);
  }

  /** Durably record the provider identity returned for an intent, before any issue settlement. */
  writeResult(result: PublicationResult): Promise<void> {
    return this.write(recordFile(result.operationKey, RESULT_PREFIX), result);
  }

  /** Durably record one issue status/comment/close effect that still has to be applied. */
  recordSettlement(settlement: PendingSettlement): Promise<void> {
    return this.write(recordFile(settlement.operationKey, SETTLEMENT_PREFIX), settlement);
  }

  /** Drop one settlement record after its effect is confirmed, so a restart never replays it. */
  async completeSettlement(key: string): Promise<void> {
    await rm(resolve(this.directory, recordFile(key, SETTLEMENT_PREFIX)), { force: true });
  }

  /** Retire one publication record pair when its pull request is gone, so the reviewed work can be published again. */
  async retirePublication(key: string): Promise<void> {
    await rm(resolve(this.directory, recordFile(key, RESULT_PREFIX)), { force: true });
    await rm(resolve(this.directory, recordFile(key, INTENT_PREFIX)), { force: true });
  }

  /** Atomically replace one record file; the intent/result records are append-only per operation key. */
  private async write(name: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const target = resolve(this.directory, name);
    const temp = resolve(this.directory, `${name}.${process.pid}.tmp`);
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temp, target);
  }
}
