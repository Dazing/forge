import type { AgentRunRequest, AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";

/** Invocation-wide lease pool. A job owns exactly one lease and releases it in finally. */
export class JobLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error(`Global job limit must be a positive integer; got ${limit}.`);
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
    try {
      return await job();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  wrap(runAgent: AgentRunner): AgentRunner {
    return <THandoff>(request: AgentRunRequest<THandoff>) => this.run(() => runAgent(request));
  }
}
