import { resolve } from "node:path";
import { requireUnchanged, runGit, snapshotRepository } from "../../infrastructure/git-provider/git.js";
import type { DraftPullRequest, GitProvider, SquashPreference } from "../../infrastructure/git-provider/git-provider.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { Ticket } from "../tickets/index.js";
import { MAX_BODY_CHARS, pullRequestHandoff } from "./pull-request-schema.js";

// Publication: read-only content stage, commits-ahead validation, final SHA, push, and draft pull-request creation.
// Each substage failure carries its name so settlement records the correct stage with the original diagnostics.

// Runner-owned note appended when the provider cannot persist a per-pull-request merge method.
const squashNote = "\n\nMerge method: squash. This provider cannot record a merge method on a draft pull request; select squash when merging.";

export type PublicationSubstage = "pull-request content" | "commit count" | "change set" | "final SHA" | "push" | "draft pull request";

/** Publication failure carrying the failing substage and the original cause; the coordinator unwraps it before building command diagnostics. */
export class PublicationError extends Error {
  constructor(
    readonly substage: PublicationSubstage,
    cause: unknown,
  ) {
    super(`publication failed at ${substage}`, { cause });
    this.name = "PublicationError";
  }
}

export interface PublishPullRequestInput {
  readonly ticket: Ticket;
  readonly workspacePath: string;
  readonly branch: string;
  readonly attemptId: string;
  readonly harness: AgentHarness;
  readonly runAgent: AgentRunner;
  readonly gitProvider: GitProvider;
  /** Record verified read-only content at its entry SHA before any publication side effects. */
  readonly onContentComplete: (head: string) => Promise<void>;
  readonly delivery?: Readonly<{
    included: readonly Readonly<{ id: string; title: string }>[];
    retryable: readonly Readonly<{ id: string; reason: string }>[];
    blocked: readonly Readonly<{ id: string; reason: string }>[];
    integrationExcluded: readonly Readonly<{ id: string; reason: string }>[];
    conflicts: readonly Readonly<{ path: string; disposition: string }>[];
  }>;
  readonly trackedPublication?: Readonly<{
    number: number;
    head: string;
    sourceSha: string;
    title: string;
    body: string;
  }>;
}

export interface PublishResult {
  readonly finalSha: string;
  readonly pullRequest: DraftPullRequest;
  readonly squashPreference: SquashPreference;
  readonly head: string;
  readonly title: string;
  readonly body: string;
}

/** Publish one attempt: content, immutability, commits ahead of base, final SHA, push, draft pull request. */
export async function publishPullRequest(input: PublishPullRequestInput): Promise<PublishResult> {
  let content: { title: string; body: string };
  try {
    const beforeContent = await snapshotRepository(input.workspacePath);
    const result = await input.runAgent({
      cwd: input.workspacePath,
      harness: input.harness,
      name: `pull-request-${input.ticket.id}-${input.attemptId}`,
      logName: `pull-request-${input.ticket.id}-${input.attemptId}`,
      promptFile: resolve(import.meta.dirname, "pull-request-prompt.md"),
      promptArgs: { TICKET_ID: input.ticket.id, TICKET_TITLE: input.ticket.title, BRANCH: input.branch, BASE_BRANCH: input.ticket.baseBranch, TICKET_CONTENT: input.ticket.content },
      handoff: pullRequestHandoff,
    });
    content = result.handoff;
    if (input.gitProvider.secrets().some((secret) => secret.length > 0 && (content.title.includes(secret) || content.body.includes(secret)))) {
      throw new Error("pull-request content contains provider credential material.");
    }
    requireUnchanged("pull-request content stage", "ticket workspace", beforeContent, await snapshotRepository(input.workspacePath));
    await input.onContentComplete(beforeContent.head);
  } catch (error) {
    throw new PublicationError("pull-request content", error);
  }

  try {
    const ahead = Number((await runGit(input.workspacePath, ["rev-list", "--count", `origin/${input.ticket.baseBranch}..HEAD`], "counting commits ahead of base branch")).trim());
    if (ahead < 1) {
      throw new Error(`Ticket branch ${input.branch} has no commits ahead of origin/${input.ticket.baseBranch}.`);
    }
  } catch (error) {
    throw new PublicationError("commit count", error);
  }

  try {
    const changed = (await runGit(input.workspacePath, ["diff", "--name-only", `origin/${input.ticket.baseBranch}`, "HEAD"], "comparing the net tree diff against the base branch")).trim();
    if (changed.length === 0) {
      throw new Error(`Ticket branch ${input.branch} has no net file changes against origin/${input.ticket.baseBranch}.`);
    }
  } catch (error) {
    throw new PublicationError("change set", error);
  }

  let finalSha: string;
  try {
    finalSha = (await runGit(input.workspacePath, ["rev-parse", "HEAD"], "reading final commit SHA")).trim();
  } catch (error) {
    throw new PublicationError("final SHA", error);
  }
  let extendTracked = false;

  try {
    if (input.trackedPublication !== undefined && input.gitProvider.getPullRequest !== undefined && input.gitProvider.updateDraftPullRequest !== undefined) {
      const current = await input.gitProvider.getPullRequest(input.ticket.repository, input.trackedPublication.number);
      extendTracked = current !== undefined
        && current.state === "open"
        && current.draft
        && current.head === input.trackedPublication.head
        && current.base === input.ticket.baseBranch
        && current.sourceSha === input.trackedPublication.sourceSha
        && current.title === input.trackedPublication.title
        && current.body === input.trackedPublication.body
        && current.squashPreference === input.gitProvider.mergeStrategySupport;
    }
    await runGit(
      input.workspacePath,
      extendTracked ? ["push", "origin", `HEAD:${input.trackedPublication!.head}`] : ["push", "--set-upstream", "origin", input.branch],
      extendTracked ? "extending tracked pull-request branch" : "pushing ticket branch",
    );
  } catch (error) {
    throw new PublicationError("push", error);
  }

  try {
    const evidence = input.delivery === undefined ? "" : [
      "",
      "## Factory delivery",
      `Included: ${input.delivery.included.map((ticket) => `${ticket.id} (${ticket.title})`).join(", ") || "none"}`,
      `Retryable: ${input.delivery.retryable.map((ticket) => `${ticket.id} — ${ticket.reason}`).join("; ") || "none"}`,
      `Blocked: ${input.delivery.blocked.map((ticket) => `${ticket.id} — ${ticket.reason}`).join("; ") || "none"}`,
      `Integration-excluded: ${input.delivery.integrationExcluded.map((ticket) => `${ticket.id} — ${ticket.reason}`).join("; ") || "none"}`,
      "Conflict resolutions:",
      ...(input.delivery.conflicts.length === 0 ? ["- none"] : input.delivery.conflicts.map((conflict) => `- ${conflict.path}: ${conflict.disposition}`)),
    ].join("\n");
    const suffix = `${evidence}${input.gitProvider.mergeStrategySupport === "unsupported" ? squashNote : ""}`;
    if (suffix.length > MAX_BODY_CHARS) throw new Error(`Runner-owned delivery evidence exceeds the ${MAX_BODY_CHARS}-character pull-request body limit.`);
    const body = `${content.body.slice(0, MAX_BODY_CHARS - suffix.length)}${suffix}`;
    if (extendTracked && input.trackedPublication !== undefined && input.gitProvider.updateDraftPullRequest !== undefined && input.gitProvider.getPullRequest !== undefined) {
      try {
        const pullRequest = await input.gitProvider.updateDraftPullRequest({
          repositoryUrl: input.ticket.repository,
          number: input.trackedPublication.number,
          head: input.trackedPublication.head,
          base: input.ticket.baseBranch,
          title: content.title,
          body,
          mergeStrategy: "squash",
          expectedSourceSha: finalSha,
          expectedTitle: input.trackedPublication.title,
          expectedBody: input.trackedPublication.body,
        });
        return { finalSha, pullRequest, squashPreference: pullRequest.squashPreference, head: input.trackedPublication.head, title: content.title, body };
      } catch (error) {
        const reconciled = await input.gitProvider.getPullRequest(input.ticket.repository, input.trackedPublication.number);
        if (reconciled?.state === "open" && reconciled.draft && reconciled.sourceSha === finalSha && reconciled.title === content.title && reconciled.body === body) {
          const pullRequest = { number: reconciled.number, url: reconciled.url, squashPreference: reconciled.squashPreference };
          return { finalSha, pullRequest, squashPreference: pullRequest.squashPreference, head: input.trackedPublication.head, title: content.title, body };
        }
        await runGit(input.workspacePath, ["push", "--set-upstream", "origin", input.branch], "pushing fresh fallback branch after pull-request update failure");
        const fallback = await input.gitProvider.createDraftPullRequest({
          repositoryUrl: input.ticket.repository,
          head: input.branch,
          base: input.ticket.baseBranch,
          title: content.title,
          body,
          mergeStrategy: "squash",
        });
        return { finalSha, pullRequest: fallback, squashPreference: fallback.squashPreference, head: input.branch, title: content.title, body };
      }
    }
    const pullRequest = await input.gitProvider.createDraftPullRequest({
      repositoryUrl: input.ticket.repository,
      head: input.branch,
      base: input.ticket.baseBranch,
      title: content.title,
      body,
      mergeStrategy: "squash",
    });
    return { finalSha, pullRequest, squashPreference: pullRequest.squashPreference, head: input.branch, title: content.title, body };
  } catch (error) {
    throw new PublicationError("draft pull request", error);
  }
}
