import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runCommand, runGit } from "../shared/git.js";
import type { Ticket } from "../tickets/tickets.js";

// Fresh per-ticket Git workspace: attempt identity, clone, and local ticket branch, split from orchestration.

export type Workspace = Readonly<{
  attemptId: string;
  workspacePath: string;
  branch: string;
}>;

export type TicketAttempt = Readonly<{
  ticket: Ticket;
  attemptId: string;
  workspacePath: string;
  branch: string;
}>;

/** Reserve a fresh `.workspaces/<slug>-<attempt-id>` directory with a six-hex attempt ID; never deletes an existing path. */
export async function reserveAttempt(workspacesRoot: string, slug: string): Promise<Workspace> {
  await mkdir(workspacesRoot, { recursive: true });
  for (let generation = 0; generation < 16; generation++) {
    const attemptId = randomBytes(3).toString("hex");
    const workspacePath = resolve(workspacesRoot, `${slug}-${attemptId}`);
    try {
      await mkdir(workspacePath);
      return { attemptId, workspacePath, branch: `agent-tickets/${slug}-${attemptId}` };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error(`Could not reserve a fresh workspace directory for ticket slug ${slug}.`);
}

/** Create the ticket workspace: base-branch validation, fresh non-shallow single-branch clone, local ticket branch, and postconditions. Partial directories stay in place on failure. */
export async function createWorkspace(ticket: Ticket, workspace: Workspace): Promise<TicketAttempt> {
  // check-ref-format resolves relative refs against a repository, so it runs in the fresh non-repo workspace directory.
  await runCommand("git", ["check-ref-format", "--branch", ticket.baseBranch], "validating base branch", workspace.workspacePath);
  await runCommand(
    "git",
    ["clone", "--origin", "origin", "--branch", ticket.baseBranch, "--single-branch", ticket.repository, workspace.workspacePath],
    "cloning ticket repository",
  );
  await runGit(workspace.workspacePath, ["switch", "-c", workspace.branch], "creating ticket branch");

  const headBranch = (await runGit(workspace.workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"], "verifying ticket branch checkout")).trim();
  if (headBranch !== workspace.branch) {
    throw new Error(`Workspace ${workspace.workspacePath} is on ${headBranch}, expected ${workspace.branch}.`);
  }
  const originUrl = (await runGit(workspace.workspacePath, ["remote", "get-url", "origin"], "verifying clone origin")).trim();
  if (originUrl !== ticket.repository) {
    throw new Error(`Workspace origin is ${originUrl}, expected ${ticket.repository}.`);
  }

  return {
    ticket,
    attemptId: workspace.attemptId,
    workspacePath: workspace.workspacePath,
    branch: workspace.branch,
  };
}
