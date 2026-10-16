// Provider-neutral contract for draft pull-request publication: one provider per runner invocation.

/** Merge method the runner requests for every draft pull request. */
export type MergeStrategy = "squash";

/** Whether a requested merge method was persisted on the created pull request. */
export type SquashPreference = "configured" | "unsupported";

/** Draft pull-request request in provider-neutral form; each provider parses `repositoryUrl` again internally. */
export type DraftPullRequestRequest = Readonly<{
  repositoryUrl: string;
  head: string;
  base: string;
  title: string;
  body: string;
  mergeStrategy: MergeStrategy;
}>;

/** Draft pull-request result; `url` is always the browser-facing page, never a provider REST resource URL. */
export type DraftPullRequest = Readonly<{
  number: number;
  url: string;
  squashPreference: SquashPreference;
}>;
export type PullRequestState = "open" | "closed" | "merged";

export type PullRequestDetails = Readonly<{
  number: number;
  url: string;
  state: PullRequestState;
  draft: boolean;
  head: string;
  base: string;
  sourceSha: string;
  title: string;
  body: string;
  squashPreference: SquashPreference;
  mergeResultSha?: string;
}>;

/** Exact restart-time lookup key: the head branch (and, when supplied, the source SHA) a runner previously published under. */
export type PullRequestRef = Readonly<{
  repository: string;
  head: string;
  base: string;
  sourceSha?: string;
}>;

/** Provider-neutral durable state of one pull request; `url` is always the browser-facing page and `mergeCommitSha` is set only for a merged pull request. */
export type PullRequestRecord = Readonly<{
  provider: ProviderName;
  repository: string;
  number: number;
  url: string;
  baseBranch: string;
  headBranch: string;
  sourceSha: string;
  title: string;
  body: string;
  draft: boolean;
  state: PullRequestState;
  mergeMethod: "squash" | "merge" | "rebase" | "unknown";
  mergeCommitSha: string | undefined;
}>;

export type UpdateDraftPullRequestRequest = DraftPullRequestRequest & Readonly<{
  number: number;
  expectedSourceSha: string;
  expectedTitle: string;
  expectedBody: string;
}>;


/** Fetch seam so tests exercise request construction and response handling without network access. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One configured Git provider: SSH URL validation and draft pull-request creation over REST. */
export interface GitProvider {
  readonly name: "github" | "azure-devops";
  readonly credential: string;
  /** Static capability read before publication: `unsupported` providers get a runner-owned merge-method note in the pull-request body. */
  readonly mergeStrategySupport: SquashPreference;

  validateRepository(repositoryUrl: string): void;
  createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequest>;
  getPullRequest?(repositoryUrl: string, number: number): Promise<PullRequestDetails | undefined>;
  /** Exact-match lookup by head/base (and source SHA when supplied) for restart recovery: finds the runner's already-created pull request without creating a second one. */
  findPullRequest(ref: PullRequestRef): Promise<PullRequestRecord | undefined>;
  updateDraftPullRequest?(request: UpdateDraftPullRequestRequest): Promise<DraftPullRequest>;
  /** Raw credential plus every derived form that must never reach a log, ticket, Git message, or command display. */
  secrets(): readonly string[];
}

/** Target provider identities the runner can construct from target credentials. */
export type ProviderName = "github" | "azure-devops";

/** Per-repository provider resolution for one invocation: every adapter with a usable target credential is configured, and each ticket's repository selects its own adapter. */
export interface GitProviderRegistry {
  readonly names: readonly ProviderName[];
  /** Aggregate credential material of every configured adapter, including derived forms, for redaction at every diagnostic boundary. */
  readonly secrets: readonly string[];
  /** Return the adapter whose canonical SSH form accepts `repositoryUrl`; a URL no configured adapter accepts is a structured `UnsupportedRepositoryError`. */
  resolve(repositoryUrl: string): GitProvider;
}

/** A repository URL no configured adapter accepts, naming the URL and the configured providers; the message never contains a credential. */
export class UnsupportedRepositoryError extends Error {
  constructor(
    readonly repositoryUrl: string,
    readonly configuredProviders: readonly ProviderName[],
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedRepositoryError";
  }
}
