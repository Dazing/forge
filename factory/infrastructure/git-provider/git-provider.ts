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
  updateDraftPullRequest?(request: UpdateDraftPullRequestRequest): Promise<DraftPullRequest>;
  /** Raw credential plus every derived form that must never reach a log, ticket, Git message, or command display. */
  secrets(): readonly string[];
}
