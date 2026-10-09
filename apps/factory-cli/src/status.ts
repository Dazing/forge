import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runEventTypes, type ArtifactEvent } from "@factory/core";
import type { FactoryConfiguration } from "./configuration.js";

const RUN_EVENT_TYPES = new Set<string>(runEventTypes);

export interface FactoryRunStatus {
  readonly runId: string;
  readonly state: "not-started" | "running" | "finished" | "terminated";
  readonly elapsedMs?: number;
  readonly remainingMs?: number;
  readonly activeOperation?: {
    readonly type: ArtifactEvent["type"];
    readonly operationId?: string;
    readonly stage?: ArtifactEvent["stage"];
    readonly attempt?: number;
    readonly repairRound?: number;
    readonly reviewedTreeId?: string;
    readonly openBlockers?: number;
    readonly occurredAt: string;
    readonly deadlineAt?: string;
  };
  readonly lastTransition?: ArtifactEvent;
  readonly lastObservation?: ArtifactEvent;
  readonly transcriptPath?: string;
  readonly supervisor?: unknown;
  readonly paths: {
    readonly events: string;
    readonly supervisor: string;
  };
}

export async function loadFactoryRunStatus(
  configuration: FactoryConfiguration,
  runId: string,
  now: () => number = Date.now,
): Promise<FactoryRunStatus> {
  const runDirectory = resolve(configuration.runRoot, "evidence", runId);
  const eventPath = resolve(runDirectory, "events.jsonl");
  const supervisorPath = resolve(runDirectory, "supervisor.json");
  const events = await readEvents(eventPath);
  const transitions = events.filter(({ eventClass }) => eventClass === "transition");
  const observations = events.filter(({ eventClass }) => eventClass === "observation");
  const first = events[0];
  const lastTransition = transitions.at(-1);
  const lastObservation = observations.at(-1);
  const transcriptEvent = events.findLast(({ type }) => type === "attempt-transcript-ready");
  const transcriptPath = typeof transcriptEvent?.details.transcriptPath === "string"
    ? transcriptEvent.details.transcriptPath
    : undefined;
  const supervisor = await readJsonIfPresent(supervisorPath);
  const finished = lastTransition?.type === "run-finished";
  const supervisorEnded = typeof supervisor === "object"
    && supervisor !== null
    && "endedAt" in supervisor
    && typeof supervisor.endedAt === "string";
  const deadlineMs = lastTransition?.deadlineAt === undefined ? undefined : Date.parse(lastTransition.deadlineAt);
  const currentMs = now();

  return {
    runId,
    state: first === undefined ? "not-started" : finished ? "finished" : supervisorEnded ? "terminated" : "running",
    ...(first === undefined ? {} : { elapsedMs: Math.max(0, currentMs - Date.parse(first.occurredAt)) }),
    ...(deadlineMs === undefined || !Number.isFinite(deadlineMs)
      ? {}
      : { remainingMs: Math.max(0, deadlineMs - currentMs) }),
    ...(lastTransition === undefined
      ? {}
      : {
          activeOperation: {
            type: lastTransition.type,
            ...(lastTransition.operationId === undefined ? {} : { operationId: lastTransition.operationId }),
            ...(lastTransition.stage === undefined ? {} : { stage: lastTransition.stage }),
            ...(lastTransition.attempt === undefined ? {} : { attempt: lastTransition.attempt }),
            ...(typeof lastTransition.details.repairRound === "number"
              ? { repairRound: lastTransition.details.repairRound }
              : {}),
            ...(typeof lastTransition.details.reviewedTreeId === "string"
              ? { reviewedTreeId: lastTransition.details.reviewedTreeId }
              : {}),
            ...(typeof lastTransition.details.openBlockers === "number"
              ? { openBlockers: lastTransition.details.openBlockers }
              : {}),
            occurredAt: lastTransition.occurredAt,
            ...(lastTransition.deadlineAt === undefined ? {} : { deadlineAt: lastTransition.deadlineAt }),
          },
          lastTransition,
        }),
    ...(lastObservation === undefined ? {} : { lastObservation }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(supervisor === undefined ? {} : { supervisor }),
    paths: { events: eventPath, supervisor: supervisorPath },
  };
}

async function readEvents(path: string): Promise<ArtifactEvent[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }
  if (content.trim().length === 0) return [];
  return content.trimEnd().split("\n").map((line, index) => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isArtifactEvent(parsed)) {
        throw new Error("event does not match schema version 1");
      }
      return parsed;
    } catch (error) {
      throw new Error(`Invalid run event at ${path}:${index + 1}`, { cause: error });
    }
  });
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed;
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isArtifactEvent(value: unknown): value is ArtifactEvent {
  return typeof value === "object"
    && value !== null
    && "schemaVersion" in value
    && value.schemaVersion === 1
    && "sequence" in value
    && Number.isSafeInteger(value.sequence)
    && "runId" in value
    && typeof value.runId === "string"
    && "occurredAt" in value
    && typeof value.occurredAt === "string"
    && "runElapsedMs" in value
    && typeof value.runElapsedMs === "number"
    && "type" in value
    && typeof value.type === "string"
    && RUN_EVENT_TYPES.has(value.type)
    && "eventClass" in value
    && (value.eventClass === "transition" || value.eventClass === "observation")
    && "details" in value
    && typeof value.details === "object"
    && value.details !== null;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}
