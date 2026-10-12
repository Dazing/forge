# Git provider and Azure DevOps implementation plan

## Outcome

Refactor the runner's Git and GitHub integration into `factory/git-provider/`, introduce a narrow provider contract, retain existing GitHub behavior, and add Azure DevOps draft pull-request support. One provider is selected per runner invocation through `GIT_PROVIDER=github|azure-devops`; every ticket in that invocation must use that provider's canonical SSH URL.

Git clone and push continue to use host SSH credentials. Provider tokens authorize pull-request REST calls only. Existing structured failures, secret redaction, retained workspaces and branches, and draft-PR behavior remain unchanged.

## Decisions

- Support one configured provider per runner invocation rather than mixing providers in one queue.
- Accept these canonical SSH repository formats:
  - GitHub: `git@github.com:<owner>/<repository>.git`
  - Azure DevOps: `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>`
- Keep subprocess execution provider-neutral; the provider contract owns repository validation and pull-request creation.
- Remove provider-specific repository fields such as `githubOwner` and `githubRepository` from `Ticket`.
- Return a browser-facing PR URL from every provider. Azure DevOps' REST response `url` is an internal API URL and must not be exposed as the completion link.
- Use Azure DevOps REST API version `7.1` and PAT Basic authentication. The PAT requires Code read/write (`vso.code_write`) permission.

## 1. Consolidate Git integration under `factory/git-provider/`

Move the current files without compatibility re-exports:

| Current | Target |
|---|---|
| `factory/shared/git.ts` | `factory/git-provider/git.ts` |
| `factory/github/pull-request-service.ts` | `factory/git-provider/github-provider.ts` |
| `factory/github/pull-request-service.test.ts` | `factory/git-provider/github-provider.test.ts` |

Update imports in:

- `factory/main.ts`
- `factory/orchestration/ticket-orchestrator.ts`
- `factory/tickets/tickets.ts`
- `factory/workspace/workspace-service.ts`
- `factory/workspace/workspace-service.test.ts`
- provider tests

Delete the obsolete `factory/github/` directory and update the implementation map in `README.md`.

Keep these provider-neutral exports in `factory/git-provider/git.ts`:

- `CommandFailure`
- `CommandFailedError`
- `runCommand`
- `runGit`
- `toCommandFailure`

## 2. Add the provider contract

Create `factory/git-provider/git-provider.ts` with common request and response models and a narrow interface:

```ts
export type DraftPullRequestRequest = Readonly<{
  repositoryUrl: string;
  head: string;
  base: string;
  title: string;
  body: string;
}>;

export type DraftPullRequest = Readonly<{
  number: number;
  url: string;
}>;

export interface GitProvider {
  readonly name: "github" | "azure-devops";
  readonly credential: string;

  validateRepository(repositoryUrl: string): void;
  createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequest>;
}
```

`validateRepository` owns provider-specific SSH URL syntax. Each implementation may parse the URL again when creating a PR; this small repeated computation avoids leaking provider coordinates into the shared ticket model or introducing an opaque generic repository abstraction.

Retain a provider-local `Fetch` seam so HTTP request construction and response handling remain testable without network access.

## 3. Add provider configuration and construction

Create `factory/git-provider/create-git-provider.ts`:

- Read and validate `GIT_PROVIDER`.
- `github` requires a nonblank `GITHUB_TOKEN`.
- `azure-devops` requires a nonblank `AZURE_DEVOPS_PAT`.
- Reject a missing or unsupported provider before ticket polling starts.
- Return the configured `GitProvider`.
- Permit fetch injection in tests without exposing it through normal composition-root usage.

Update `factory/main.ts`:

- Replace `requireGithubToken()` with `createGitProvider(process.env)`.
- Pass the provider into `loadTicket` and `solveTickets`.
- Pass the selected provider credential into diagnostic redaction.
- Preserve `--help`: it must return before loading `.env`, validating credentials, or starting Docker preflight.

Rename GitHub-specific diagnostic fields throughout the runner:

- `githubToken` to `credential` or `secret`.
- `InvocationLogger.githubToken` to provider-neutral secret storage.
- `FailureAnnotation.githubToken` to `secret`.

This gives GitHub and Azure DevOps the same failure and redaction path.

## 4. Convert GitHub to `GitProvider`

Refactor the current implementation into `GitHubProvider`:

- Validate `git@github.com:<owner>/<repository>.git`.
- Parse owner and repository internally.
- Preserve `POST https://api.github.com/repos/{owner}/{repository}/pulls`.
- Preserve Bearer authentication, GitHub API version, user-agent, and `draft: true`.
- Preserve Zod response validation and return `html_url` as the browser URL.
- Preserve structured HTTP and transport failures.
- Ensure the token cannot appear in displayed commands, response evidence, logs, or ticket annotations.

This step is behavior-preserving for existing GitHub tickets.

## 5. Implement `AzureDevOpsProvider`

Create `factory/git-provider/azure-devops-provider.ts`.

### Repository parsing

- Accept `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>`.
- Require nonempty organization, project, and repository segments.
- Reject malformed URLs, HTTPS URLs, legacy Azure SSH hosts, and unrelated providers.
- URI-encode organization, project, and repository independently when constructing HTTP and browser URLs.

### Request

Create a draft pull request with:

```http
POST https://dev.azure.com/{organization}/{project}/_apis/git/repositories/{repository}/pullrequests?api-version=7.1
Authorization: Basic base64(":" + PAT)
Content-Type: application/json
```

Payload:

```json
{
  "sourceRefName": "refs/heads/<head>",
  "targetRefName": "refs/heads/<base>",
  "title": "<title>",
  "description": "<body>",
  "isDraft": true
}
```

### Response and failures

- Validate `pullRequestId` as an integer.
- Return `number: pullRequestId`.
- Construct the browser URL as `https://dev.azure.com/{organization}/{project}/_git/{repository}/pullrequest/{pullRequestId}`.
- Do not return Azure DevOps' response `url`, which identifies the REST resource.
- Convert non-2xx responses, malformed JSON, invalid response bodies, and transport errors into `CommandFailedError` with the HTTP status as the exit code where available.
- Redact both the raw PAT and its derived Basic authorization value from diagnostics.

Reference: [Azure DevOps Pull Requests - Create, REST API 7.1](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1) and [Authentication with Azure Repos](https://learn.microsoft.com/azure/devops/repos/git/auth-overview?view=azure-devops).

## 6. Make ticket metadata provider-neutral

Update `factory/tickets/tickets.ts`:

- Change `loadTicket(path)` to `loadTicket(path, provider)`.
- Validate `repository` as a nonblank string in the front-matter schema, then call `provider.validateRepository(repository)`.
- Remove `githubSshUrl`, `githubOwner`, and `githubRepository`.
- Keep the canonical clone URL in `Ticket.repository`.
- Translate provider validation failures into the existing `TicketMetadataError` shape so invalid repository URLs remain ticket-scoped failures.
- Keep ticket ID, slug, title, body, base-branch, formatting, and planner validation behavior unchanged.

Update ticket fixtures and tests to use provider-neutral `Ticket` values. Add coverage proving:

- GitHub accepts its canonical SSH URL.
- Azure DevOps accepts its canonical SSH URL.
- Each provider rejects the other provider's URL.
- Azure URLs missing organization, project, or repository are rejected.
- Existing front-matter, slug, title, and base-branch behavior remains intact.

## 7. Inject the provider into orchestration

Replace `SolveContext.githubToken` with:

```ts
readonly gitProvider: GitProvider;
```

In `factory/orchestration/ticket-orchestrator.ts`, replace the direct GitHub service call with:

```ts
const pullRequest = await context.gitProvider.createDraftPullRequest({
  repositoryUrl: ticket.repository,
  head: attempt.branch,
  base: ticket.baseBranch,
  title: content.title,
  body: content.body,
});
```

Keep the publication sequence unchanged:

1. Clone the ticket repository over SSH.
2. Run implementation and review.
3. Commit remaining changes.
4. Confirm at least one commit is ahead of the base branch.
5. Push the ticket branch over SSH.
6. Ask the selected provider to create a draft PR.
7. Annotate and move the ticket.

If push succeeds but PR creation fails, retain the remote branch and perform no rollback.

## 8. Update environment configuration

Update the ignored root `.env` for the intended Azure DevOps run without copying credentials into tracked files:

```dotenv
GIT_PROVIDER=azure-devops
AZURE_DEVOPS_PAT=<local secret>
```

A GitHub configuration remains available when switching providers:

```dotenv
GIT_PROVIDER=github
GITHUB_TOKEN=<local secret>
```

Update `.env.example` with empty values only:

```dotenv
# github or azure-devops
GIT_PROVIDER=github

# Required when GIT_PROVIDER=github
GITHUB_TOKEN=

# Required when GIT_PROVIDER=azure-devops
# PAT scope: Code (Read & write)
AZURE_DEVOPS_PAT=
```

Never copy the existing `.env` credential into source, tests, logs, documentation, or `.env.example`. Rotate the current GitHub credential because it was surfaced during repository inspection.

## 9. Update user-facing documentation and prompts

Update `README.md` and `factory/cli/cli.ts` to document:

- Provider selection and provider-specific credentials.
- Both supported SSH URL formats.
- SSH authorization remains independent from REST authentication.
- Azure DevOps PAT Code read/write permission.
- One provider per invocation.
- GitHub and Azure DevOps ticket front-matter examples.
- The new `factory/git-provider/` structure.
- Live publication remains a credentialed smoke path, not a hermetic automated test.

Update agent prompt wording that currently prohibits only GitHub operations. Use provider-neutral restrictions and explicitly prohibit remote branch mutation, `git push`, `gh`, `az repos`, and direct Git-provider API calls; the TypeScript runner owns publication.

## 10. Tests and verification

### Automated tests

Add or update tests for:

1. GitHub provider request headers and payload, response parsing, malformed response, HTTP failure, transport failure, and token redaction.
2. Azure DevOps provider endpoint encoding, Basic authentication, fully qualified branch refs, `isDraft: true`, browser URL construction, malformed response, HTTP failure, transport failure, and redaction of both raw and encoded credentials.
3. Provider factory selection, unsupported `GIT_PROVIDER`, missing provider-specific credential, and blank credential.
4. Ticket parsing and repository rejection under both providers.
5. Existing workspace and lifecycle behavior after import and terminology changes.

Run:

```bash
npm test
npm run typecheck
npm run sandcastle -- --help
```

### Publication smoke tests

Use disposable repositories and credentials:

1. GitHub: process one ticket through SSH clone, push, and draft PR creation.
2. Azure DevOps: process one ticket with the canonical Azure SSH URL and verify:
   - the branch exists in Azure Repos;
   - the PR is created as a draft;
   - the completion annotation links to the browser-facing PR page;
   - the ticket moves to `done/`.
3. Inspect the resulting ticket and invocation `main.log`; neither raw provider credential nor the encoded Azure Basic authorization value may appear.
