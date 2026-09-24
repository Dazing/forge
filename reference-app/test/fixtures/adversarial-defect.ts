/**
 * Adversarial-review defect fixture.
 *
 * Simulates the scenario from agent-assets/suite/cases/adversarial-review/case.yaml:
 * `src/export/worker.ts` line 84 — a cancellation path that returns before
 * persisting the export's terminal state, so a canceled job remains marked running.
 *
 * This fixture is NEVER imported by the default app build.
 * It exists only for reviewer-only benchmark runs and task-shape documentation.
 *
 * The `worker.ts` below is a minimal simulation of the defect.
 * The correct implementation (marked in a comment) is what a reviewer should find missing.
 */

type ExportJobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

interface ExportJob {
  id: string;
  state: ExportJobState;
  result?: string;
}

/**
 * Simulated cancellation path with the seeded defect.
 *
 * DEFECT: The cancel path returns before persisting the terminal state.
 * The job remains in `running` state instead of being marked `canceled`.
 *
 * Correct implementation would persist `canceled` state before returning:
 *   job.state = 'canceled';
 *   saveJob(job);
 */
export function cancelExport(job: ExportJob, save: (job: ExportJob) => void): void {
  if (job.state !== 'running') {
    return;
  }
  // DEFECT: early return without persisting terminal state
  // Correct code would be:
  //   job.state = 'canceled';
  //   save(job);
  return;
}
