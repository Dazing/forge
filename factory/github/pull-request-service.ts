import { z } from "zod";
import { CommandFailedError } from "../shared/git.js";
import { redactSecret } from "../shared/invocation-log.js";

// GitHub draft pull-request creation through the REST API, split from orchestration.

const API_BASE = "https://api.github.com";

export interface DraftPullRequestRequest {
  readonly token: string;
  readonly owner: string;
  readonly repository: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export interface DraftPullRequest {
  readonly number: number;
  readonly url: string;
}

/** Fetch seam so tests exercise request construction and response handling without network access. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const pullResponseSchema = z.object({
  number: z.number().int(),
  html_url: z.string().url().min(1),
});

/** Create one draft pull request from the ticket branch to the ticket base branch; the token never appears in the displayed command. */
export async function createDraftPullRequest(request: DraftPullRequestRequest, fetchImpl: Fetch = globalThis.fetch): Promise<DraftPullRequest> {
  const path = `/repos/${request.owner}/${request.repository}/pulls`;
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
    response = await fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
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
        stderr: redactSecret(request.token, error instanceof Error ? error.message : String(error)),
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
        stdout: redactSecret(request.token, text),
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

  return { number: parsed.number, url: parsed.html_url };
}
