// Public surface of the private GitHub backlog transport: raw issue/comment/Project records,
// typed failures, and the configured client. Scheduling policy, ticket parsing, and status
// transitions belong to the features that consume this module.

export { BacklogConfigurationError, BacklogConflictError, BacklogHttpError } from "./github-backlog-errors.js";
export type { BacklogFailure } from "./github-backlog-errors.js";
export type { BacklogComment, BacklogIssue, BacklogProjectEntry, BacklogProjectItem, BacklogStatusField, BacklogStatusOption, GitHubBacklog, NewComment } from "./github-backlog-types.js";
export { createGitHubBacklog } from "./github-backlog.js";
