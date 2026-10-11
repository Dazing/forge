import { Output } from "@ai-hero/sandcastle";
import { resolve } from "node:path";
import { requireUnchanged, runGit, snapshotRepository } from "../../infrastructure/git-provider/git.js";
import type { DraftPullRequest, GitProvider, SquashPreference } from "../../infrastructure/git-provider/git-provider.js";
import type { AgentRunner } from "../../infrastructure/agent-runtime/agent-runtime.js";
import { type AgentHarness } from "../../infrastructure/sandbox/sandbox.js";
import type { Ticket } from "../tickets/index.js";
import { MAX_BODY_CHARS, pullRequestSchema } from "./pull-request-schema.js";

// Publication: read-only content stage, commits-ahead validation, final SHA, push, and draft pull-request creation.
// Each substage failure carries its name so settlement records the correct stage with the original diagnostics.

const COMPLETE = "<promise>COMPLETE</promise>";
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
}

export interface PublishResult {
  readonly finalSha: string;
  readonly pullRequest: DraftPullRequest;
  readonly squashPreference: SquashPreference;
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
      completionSignal: COMPLETE,
      output: Output.object({ tag: "pull-request", schema: pullRequestSchema }),
    });
    if (result.completionSignal !== COMPLETE) {
      throw new Error("pull-request agent did not complete");
    }
    content = result.output;
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

  try {
    await runGit(input.workspacePath, ["push", "--set-upstream", "origin", input.branch], "pushing ticket branch");
  } catch (error) {
    throw new PublicationError("push", error);
  }

  try {
    const body = input.gitProvider.mergeStrategySupport === "unsupported"
      ? `${content.body.slice(0, MAX_BODY_CHARS - squashNote.length)}${squashNote}`
      : content.body;
    const pullRequest = await input.gitProvider.createDraftPullRequest({
      repositoryUrl: input.ticket.repository,
      head: input.branch,
      base: input.ticket.baseBranch,
      title: content.title,
      body,
      mergeStrategy: "squash",
    });
    return { finalSha, pullRequest, squashPreference: pullRequest.squashPreference };
  } catch (error) {
    throw new PublicationError("draft pull request", error);
  }
}
