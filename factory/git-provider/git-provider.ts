// Provider-neutral contract for draft pull-request publication: one provider per runner invocation.

/** Draft pull-request request in provider-neutral form; each provider parses `repositoryUrl` again internally. */
export type DraftPullRequestRequest = Readonly<{
  repositoryUrl: string;
  head: string;
  base: string;
  title: string;
  body: string;
}>;

/** Draft pull-request result; `url` is always the browser-facing page, never a provider REST resource URL. */
export type DraftPullRequest = Readonly<{
  number: number;
  url: string;
}>;

/** Fetch seam so tests exercise request construction and response handling without network access. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** One configured Git provider: SSH URL validation and draft pull-request creation over REST. */
export interface GitProvider {
  readonly name: "github" | "azure-devops";
  readonly credential: string;

  validateRepository(repositoryUrl: string): void;
  createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequest>;
}
