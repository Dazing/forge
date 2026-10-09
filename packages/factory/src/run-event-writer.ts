import type {
  ArtifactEvent,
  RunArtifactsPort,
  RunEventDraft,
} from "./contracts.js";

export interface RunEventWriterOptions {
  readonly runId: string;
  readonly artifacts: RunArtifactsPort;
  readonly progress?: (event: ArtifactEvent) => void;
  readonly now?: () => number;
}

/** Assigns one durable order to run events before exposing them live. */
export class RunEventWriter {
  readonly #artifacts: RunArtifactsPort;
  readonly #now: () => number;
  readonly #progress: ((event: ArtifactEvent) => void) | undefined;
  readonly #runId: string;
  readonly #startedAtMs: number;
  #pending: Promise<void> = Promise.resolve();
  #sequence = 0;

  constructor(options: RunEventWriterOptions) {
    this.#runId = options.runId;
    this.#artifacts = options.artifacts;
    this.#progress = options.progress;
    this.#now = options.now ?? Date.now;
    this.#startedAtMs = this.#now();
  }

  emit(draft: RunEventDraft): Promise<ArtifactEvent> {
    const operation = async (): Promise<ArtifactEvent> => {
      const occurredAtMs = this.#now();
      const event: ArtifactEvent = {
        ...draft,
        schemaVersion: 1,
        sequence: ++this.#sequence,
        runId: this.#runId,
        occurredAt: new Date(occurredAtMs).toISOString(),
        runElapsedMs: Math.max(0, occurredAtMs - this.#startedAtMs),
      };
      await this.#artifacts.record(event);
      this.#progress?.(event);
      return event;
    };

    const result = this.#pending.then(operation, operation);
    this.#pending = result.then(() => undefined, () => undefined);
    return result;
  }
}
