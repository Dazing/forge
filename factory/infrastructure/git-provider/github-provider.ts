import { z } from "zod";
import { CommandFailedError } from "./git.js";
import { redactSecret } from "../../shared/redact-secret.js";
import type { DraftPullRequest, DraftPullRequestRequest, Fetch, GitProvider } from "./git-provider.js";

// GitHub draft pull-request creation through the REST API, split from orchestration.

const API_BASE = "https://api.github.com";
const githubSshUrl = /^git@github\.com:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\.git$/;

const pullResponseSchema = z.object({
  number: z.number().int(),
  html_url: z.string().url().min(1),
});

/** GitHub provider: canonical `git@github.com:<owner>/<repository>.git` SSH URLs and the GitHub REST pulls endpoint. */
export class GitHubProvider implements GitProvider {
  readonly name = "github" as const;
  // GitHub's REST pull-request endpoints have no per-pull-request merge-method field; repository-level merge settings are never rewritten.
  readonly mergeStrategySupport = "unsupported" as const;

  constructor(
    readonly credential: string,
    private readonly fetchImpl: Fetch = globalThis.fetch,
  ) {}

  /** Raw token; GitHub has no derived credential form. */
  secrets(): readonly string[] {
    return [this.credential];
  }

  /** Require the exact GitHub SSH form; HTTPS, GitHub Enterprise, ssh://, and missing `.git` are rejected. */
  validateRepository(repositoryUrl: string): void {
    if (!githubSshUrl.test(repositoryUrl)) {
      throw new Error(`Repository must be a git@github.com:<owner>/<repository>.git SSH URL; got ${repositoryUrl}.`);
    }
  }

  /** Create one draft pull request from the ticket branch to the ticket base branch; the token never appears in the displayed command. */
  async createDraftPullRequest(request: DraftPullRequestRequest): Promise<DraftPullRequest> {
    const ssh = githubSshUrl.exec(request.repositoryUrl);
    if (!ssh) {
      throw new Error(`Repository must be a git@github.com:<owner>/<repository>.git SSH URL; got ${request.repositoryUrl}.`);
    }
    const path = `/repos/${ssh[1]}/${ssh[2]}/pulls`;
    const displayCommand = `POST ${API_BASE}${path}`;
    const payload = JSON.stringify({
      title: request.title,
      head: request.head,
      base: request.base,
      body: request.body,
      draft: true,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(`${API_BASE}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.credential}`,
          "X-GitHub-Api-Version": "2022-11-28",
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
          stderr: redactSecret(this.credential, error instanceof Error ? error.message : String(error)),
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
          stdout: redactSecret(this.credential, text),
          stderr: `HTTP ${response.status} ${response.statusText}`,
        },
        cause,
      );

    if (!response.ok) {
      throw failure(response.status, new Error(`GitHub rejected the draft pull request: HTTP ${response.status}.`));
    }

    let parsed: z.infer<typeof pullResponseSchema>;
    try {
      parsed = pullResponseSchema.parse(JSON.parse(text));
    } catch (error) {
      throw failure(response.status, new Error(`GitHub response is missing a valid number and html_url: ${error instanceof Error ? error.message : String(error)}`));
    }

    return { number: parsed.number, url: parsed.html_url, squashPreference: "unsupported" };
  }
}
