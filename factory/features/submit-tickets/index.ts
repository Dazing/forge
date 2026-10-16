// Public surface of the submission feature (plan §3 D4): the host CLI gets one command, the report it
// prints, and the failure types it maps to exit codes. Batch validation, sidecars, locks, and status
// policy stay inside this feature; the backlog transport and the target provider are passed in.

export { READY_FOR_DEVELOPMENT, STAGING, SubmissionGateError, submitTickets, type SubmitTicketsInput } from "./submit-tickets.js";
export { SubmissionLockError, SUBMISSION_LOCK_FILE } from "./submission-state.js";
export { renderJsonReport, renderTextReport, type SubmissionReport } from "./submission-report.js";
export {
  commentMarker,
  submissionOperationKey,
  submissionRecordSchema,
  submissionStatePath,
  submissionTotals,
  SUBMISSION_STATE_VERSION,
  type SubmissionEntry,
  type SubmissionOutcome,
  type SubmissionRecord,
  type SubmissionResult,
  type SubmissionTotals,
} from "./submission-schema.js";
