import { z } from "zod";
import { CommandFailedError } from "./git.js";
import { redactSecret } from "../../shared/redact-secret.js";
import type { DraftPullRequest, DraftPullRequestRequest, Fetch, GitProvider } from "./git-provider.js";

// Azure DevOps draft pull-request creation through the REST API, mirroring the GitHub provider's failure shape.

const API_BASE = "https://dev.azure.com";
const azureSshUrl = /^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/;

const pullResponseSchema = z.object({
  pullRequestId: z.number().int(),
  isDraft: z.boolean(),
  completionOptions: z.object({ mergeStrategy: z.string() }).optional(),
});

/** Azure DevOps provider: canonical `git@ssh.dev.azure.com:v3/<organization>/<project>/<repository>` SSH URLs and the 7.1 REST pulls endpoint. */
export class AzureDevOpsProvider implements GitProvider {
  readonly name = "azure-devops" as const;
  // Azure DevOps records the merge method per pull request through `completionOptions`.
  readonly mergeStrategySupport = "configured" as const;

  constructor(
    readonly credential: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  /** Raw PAT plus the derived Basic value, both of which must never reach a log, ticket, Git message, or command display. */
  secrets(): readonly string[] {
    return [this.credential, Buffer.from(`:${this.credential}`, "utf8").toString("base64")];
  }

  /** Require the exact current Azure SSH form; HTTPS URLs, legacy `ssh.visualstudio.com` hosts, and empty segments are rejected. */
  validateRepository(repositoryUrl: string): void {
    const segments = azureSshUrl.exec(repositoryUrl);
    if (!segments) {
      throw new Error(`Repository must be a git@ssh.dev.azure.com:v3/<organization>/<project>/<repository> SSH URL; got ${repositoryUrl}.`);
    }
    for (const segment of [segments[1]!, segments[2]!, segments[3]!]) {
      if (segment.length === 0) {
        throw new Error(`Repository URL has an empty organization, project, or repository segment; got ${repositoryUrl}.`);
      }
    }
  }

  /** Create one draft pull request from the ticket branch to the ticket base branch; the completion URL is the browser page, never the REST resource URL. */
  async createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequest> {
    const ssh = azureSshUrl.exec(request.repositoryUrl);
    if (!ssh) {
      throw new Error(`Repository must be a git@ssh.dev.azure.com:v3/<organization>/<project>/<repository> SSH URL; got ${request.repositoryUrl}.`);
    }
    const organization = encodeURIComponent(ssh[1]!);
    const project = encodeURIComponent(ssh[2]!);
    const repository = encodeURIComponent(ssh[3]!);
    const encodedPat = Buffer.from(`:${this.credential}`, "utf8").toString("base64");
    // The encoded Basic value is a derived credential: redact it alongside the raw PAT in every diagnostic.
    const redact = (text: string): string => redactSecret(encodedPat, redactSecret(this.credential, text));

    const path = `/${organization}/${project}/_apis/git/repositories/${repository}/pullrequests?api-version=7.1`;
    const displayCommand = `POST ${API_BASE}${path}`;
    const payload = JSON.stringify({
      sourceRefName: `refs/heads/${request.head}`,
      targetRefName: `refs/heads/${request.base}`,
      title: request.title,
      description: request.body,
      isDraft: true,
      completionOptions: {
        mergeStrategy: request.mergeStrategy,
        isDraft: true,
        deleteSourceBranch: false,
        bypassPolicy: false,
      },
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${encodedPat}`,
          "User-Agent": "sandcastle-runner",
          "Content-Type": "application/json",
        },
        body: payload,
      });
    } catch (error) {
      throw new CommandFailedError(
        {
          operation: "creating draft pull request",
          command: displayCommand,
          exitCode: 1,
          stdout: "",
          stderr: redact(error instanceof Error ? error.message : String(error)),
        },
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    const text = await response.text();
    const failure = (exitCode: number, cause: Error): CommandFailedError =>
      new CommandFailedError(
        {
          operation: "creating draft pull request",
          command: displayCommand,
          exitCode,
          stdout: redact(text),
          stderr: redact(`HTTP ${response.status} ${response.statusText}\n${cause.message}`),
        },
        cause,
      );

    if (!response.ok) {
      throw failure(response.status, new Error(`Azure DevOps rejected the draft pull request: HTTP ${response.status}.`));
    }

    let parsed: z.infer<typeof pullResponseSchema>;
    try {
      parsed = pullResponseSchema.parse(JSON.parse(text));
    } catch (error) {
      throw failure(response.status, new Error(`Azure DevOps response is missing a valid pullRequestId: ${error instanceof Error ? error.message : String(error)}`));
    }

    const pullRequestUrl = `${API_BASE}/${organization}/${project}/_git/${repository}/pullrequest/${parsed.pullRequestId}`;
    if (!parsed.isDraft) {
      throw failure(response.status, new Error(`Azure DevOps created pull request ${parsed.pullRequestId} at ${pullRequestUrl} as a non-draft; the runner never publishes a ready-to-merge pull request.`));
    }

    let mergeStrategy = parsed.completionOptions?.mergeStrategy;
    if (mergeStrategy === undefined) {
      const readPath = `/${organization}/${project}/_apis/git/repositories/${repository}/pullrequests/${parsed.pullRequestId}?api-version=7.1`;
      const readCommand = `GET ${API_BASE}${readPath}`;
      let readResponse: Response;
      let readText: string;
      try {
        readResponse = await this.fetchImpl(`${API_BASE}${readPath}`, {
          method: "GET",
          headers: { Authorization: `Basic ${encodedPat}`, "User-Agent": "sandcastle-runner" },
        });
        readText = await readResponse.text();
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new CommandFailedError(
          { operation: "creating draft pull request", command: readCommand, exitCode: 1, stdout: "", stderr: redact(`${cause.message}\nCreated pull request: ${pullRequestUrl}`) },
          cause,
        );
      }
      const readFailure = (cause: Error): CommandFailedError => new CommandFailedError(
        {
          operation: "creating draft pull request",
          command: readCommand,
          exitCode: readResponse.status,
          stdout: redact(readText),
          stderr: redact(`HTTP ${readResponse.status} ${readResponse.statusText}\n${cause.message}\nCreated pull request: ${pullRequestUrl}`),
        },
        cause,
      );
      if (!readResponse.ok) {
        throw readFailure(new Error(`Azure DevOps rejected pull-request read-back: HTTP ${readResponse.status}.`));
      }
      let readParsed: z.infer<typeof pullResponseSchema>;
      try {
        readParsed = pullResponseSchema.parse(JSON.parse(readText));
      } catch (error) {
        throw readFailure(new Error(`Azure DevOps read-back response is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
      if (readParsed.pullRequestId !== parsed.pullRequestId) {
        throw readFailure(new Error(`Azure DevOps read-back returned pull request ${readParsed.pullRequestId}, expected ${parsed.pullRequestId}.`));
      }
      if (!readParsed.isDraft) {
        throw readFailure(new Error("Azure DevOps read-back returned a non-draft pull request."));
      }
      mergeStrategy = readParsed.completionOptions?.mergeStrategy;
      if (mergeStrategy !== request.mergeStrategy) {
        throw readFailure(new Error(`Azure DevOps read-back returned merge strategy ${mergeStrategy ?? "none"} instead of ${request.mergeStrategy}.`));
      }
    }

    if (mergeStrategy !== request.mergeStrategy) {
      throw failure(response.status, new Error(`Azure DevOps created pull request ${parsed.pullRequestId} at ${pullRequestUrl} with merge strategy ${mergeStrategy ?? "none"} instead of ${request.mergeStrategy}.`));
    }

    return { number: parsed.pullRequestId, url: pullRequestUrl, squashPreference: "configured" };
  }
}
