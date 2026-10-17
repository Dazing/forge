import assert from "node:assert/strict";
import { test } from "node:test";
import { claimed, declaredRepository, discoverBacklogTickets, schedulable, type BacklogDiscovery } from "./backlog-discovery.js";
import type { BacklogComment, BacklogIssue, BacklogProjectEntry, BacklogProjectItem, BacklogStatusField, GitHubBacklog } from "../../infrastructure/github-backlog/index.js";
import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";

const providers = createGitProviderRegistry({ GITHUB_TOKEN: "ghp_test_credential_1234" }, async () => new Response("{}"));

function ticketIssue(number: number, id = `ticket-${number}`, repository = "git@github.com:acme/app.git"): BacklogIssue {
  return {
    number,
    nodeId: `I_NODE_${number}`,
    url: `https://github.com/acme/backlog/issues/${number}`,
    title: `Ticket ${number}`,
    body: [
      "---",
      `id: ${id}`,
      `name: Ticket ${number}`,
      `repository: ${repository}`,
      "baseBranch: main",
      "---",
      `# Ticket ${number}`,
      "",
      "Requirements.",
    ].join("\n"),
    state: "open",
    stateReason: undefined,
    revision: "2026-10-16T07:00:00.000Z",
    author: "author",
  };
}

class FakeBacklog implements GitHubBacklog {
  readonly repository = "acme/backlog";
  readonly projectId = "PVT_1";
  readonly secrets = ["ghp_test_credential_1234"];

  constructor(
    readonly issues: readonly BacklogIssue[],
    readonly items: readonly BacklogProjectEntry[],
  ) {}

  async validateRepository(): Promise<{ private: boolean; fullName: string }> {
    return { private: true, fullName: this.repository };
  }
  async validateProject(): Promise<BacklogStatusField> {
    throw new Error("discovery never touches the Project status field");
  }
  async listIssues(): Promise<readonly BacklogIssue[]> {
    return this.issues;
  }
  async getIssue(): Promise<BacklogIssue | undefined> {
    throw new Error("discovery never reads one issue");
  }
  async createIssue(): Promise<{ number: number; nodeId: string; url: string }> {
    throw new Error("discovery never creates issues");
  }
  async updateIssueBody(): Promise<BacklogIssue> {
    throw new Error("discovery never rewrites issue bodies");
  }
  async createComment(): Promise<{ id: number; url: string }> {
    throw new Error("discovery never comments");
  }
  async listComments(): Promise<readonly BacklogComment[]> {
    return [];
  }
  async closeIssueCompleted(): Promise<void> {
    throw new Error("discovery never closes issues");
  }
  async findProjectItem(): Promise<BacklogProjectItem | undefined> {
    throw new Error("discovery reads the board in bulk");
  }
  async listProjectItems(): Promise<readonly BacklogProjectEntry[]> {
    return this.items;
  }
  async setProjectStatus(): Promise<void> {
    throw new Error("discovery never writes status");
  }
}

function entry(number: number, status?: string): BacklogProjectEntry {
  return {
    issueNodeId: `I_NODE_${number}`,
    issueNumber: number,
    itemId: `PVTI_${number}`,
    status: status === undefined ? undefined : { optionId: `option-${status.toLowerCase().replaceAll(" ", "-")}`, name: status },
  };
}

async function discover(issues: readonly BacklogIssue[], items: readonly BacklogProjectEntry[]): Promise<BacklogDiscovery> {
  return discoverBacklogTickets(new FakeBacklog(issues, items), providers);
}

test("every open issue is parsed as a ticket in issue-number order with its board status", async () => {
  const discovery = await discover(
    [ticketIssue(3), { ...ticketIssue(2), state: "closed", stateReason: "completed" }, ticketIssue(1)],
    [entry(1, "Ready"), entry(3, "In review"), entry(2, "Done")],
  );

  assert.deepEqual(discovery.tickets.map((ticket) => [ticket.ticket.id, ticket.status]), [["ticket-1", "Ready"], ["ticket-3", "In review"]]);
  assert.equal(discovery.tickets[0]!.ticket.repository, "git@github.com:acme/app.git");
  assert.equal(discovery.tickets[0]!.snapshot.identity.number, 1);
  assert.equal(discovery.tickets[0]!.snapshot.identity.nodeId, "I_NODE_1");
  assert.deepEqual([discovery.failures, discovery.duplicates, discovery.unboarded], [[], [], []]);
});

test("an issue body that is not a ticket is reported by issue identity and never scheduled", async () => {
  const discovery = await discover(
    [{ ...ticketIssue(4), body: "Just a bug report, no front matter." }, { ...ticketIssue(3), body: "---\nrepository: git@github.com:acme/app.git\n---\n# Missing identity\n" }],
    [entry(4, "Ready"), entry(3, "Ready")],
  );

  assert.deepEqual(discovery.tickets, []);
  assert.deepEqual(discovery.failures.map((failure) => [failure.issueNumber, failure.issueUrl]), [[3, "https://github.com/acme/backlog/issues/3"], [4, "https://github.com/acme/backlog/issues/4"]]);
  assert.match(discovery.failures[0]!.reason, /id/);
  assert.match(discovery.failures[1]!.reason, /declares no target repository/);
});

test("a target repository no configured adapter accepts is reported with the missing credential", async () => {
  const discovery = await discover([ticketIssue(5, "ticket-ado", "git@ssh.dev.azure.com:v3/acme/project/repo")], [entry(5, "Ready")]);

  assert.deepEqual(discovery.tickets, []);
  assert.match(discovery.failures[0]!.reason, /AZURE_DEVOPS_PAT/);
});

test("one ticket ID declared by two issues blocks both from scheduling", async () => {
  const discovery = await discover([ticketIssue(6, "ticket-dup"), ticketIssue(9, "ticket-dup"), ticketIssue(7)], [entry(6, "Ready"), entry(9, "Ready"), entry(7, "Ready")]);

  assert.deepEqual(discovery.duplicates, [{ ticketId: "ticket-dup", issueNumbers: [6, 9] }]);
  assert.deepEqual(discovery.tickets.map((ticket) => ticket.ticket.id), ["ticket-7"]);
});

test("an open issue absent from the Project is reported unboarded and never schedulable", async () => {
  const discovery = await discover([ticketIssue(8)], []);

  assert.deepEqual(discovery.unboarded, [8]);
  assert.equal(discovery.tickets[0]!.status, undefined);
  assert.deepEqual(schedulable(discovery), []);
});

test("only Ready and In progress issues are schedulable, and In progress marks a claim", async () => {
  const discovery = await discover(
    [ticketIssue(10), ticketIssue(11), ticketIssue(12), ticketIssue(13), ticketIssue(14)],
    [entry(10, "Backlog"), entry(11, "Ready"), entry(12, "In progress"), entry(13, "In review"), entry(14, "Blocked")],
  );

  assert.deepEqual(schedulable(discovery).map((ticket) => ticket.ticket.id), ["ticket-11", "ticket-12"]);
  assert.deepEqual(claimed(discovery).map((ticket) => ticket.ticket.id), ["ticket-12"]);
});

test("the declared repository routes an issue to a provider before its full parse", () => {
  assert.equal(declaredRepository(ticketIssue(1).body), "git@github.com:acme/app.git");
  assert.equal(declaredRepository("no front matter here"), undefined);
  assert.equal(declaredRepository("---\nrepository: [\n---\nbody"), undefined);
  assert.equal(declaredRepository("---\nname: no repository\n---\nbody"), undefined);
});
