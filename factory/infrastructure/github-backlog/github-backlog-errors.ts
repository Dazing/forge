// Typed backlog failures: transport, revision, and configuration, all redaction-safe by construction.
// Local to the transport; the CommandFailure field shape is mirrored so callers format backlog and
// Git subprocess diagnostics identically without this module importing subprocess machinery.

/** Transport-shaped diagnostics: the operation, the redacted request display, and the response body. */
export type BacklogFailure = Readonly<{
  operation: string;
  command: string;
  status: number;
  stdout: string;
  stderr: string;
}>;

/** GitHub request failure carrying redacted status, body, and transport diagnostics. */
export class BacklogHttpError extends Error {
  readonly operation: string;
  readonly command: string;
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(
    readonly failure: BacklogFailure,
    cause: unknown,
  ) {
    super(`Backlog request failed while ${failure.operation}: ${failure.command} returned ${failure.status}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "BacklogHttpError";
    this.operation = failure.operation;
    this.command = failure.command;
    this.status = failure.status;
    this.stdout = failure.stdout;
    this.stderr = failure.stderr;
  }
}

/** Issue revision mismatch: the issue moved between the read that authorized the write and the write. */
export class BacklogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacklogConflictError";
  }
}

/** Backlog configuration is unusable: public/missing/forbidden repository, inaccessible/public Project, missing Status field, missing status option. */
export class BacklogConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacklogConfigurationError";
  }
}
