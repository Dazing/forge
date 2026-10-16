import { test } from "node:test";
import assert from "node:assert/strict";

import { createGitProviderRegistry } from "../../infrastructure/git-provider/create-git-provider.js";
import type { IssueIdentity } from "../tickets/index.js";
import { parseAuthoredIssueSnapshot } from "../tickets/index.js";

import {
  AuthorizationWithdrawnError,
  createGroupAuthorization,
  createIssueAuthorizationReader,
  createStageAuthorization,
  isAuthorizationWithdrawn,
} from "./authorization-guard.js";
import { TEST_GITHUB_TOKEN, TestBacklog } from "./test-backlog.js";

// The board is the authority, so these tests move real fixture issues and statuses and assert exactly
// which withdrawal the guard reports at a side-effect boundary.

const providers = createGitProviderRegistry({ GITHUB_TOKEN: TEST_GITHUB_TOKEN });

function fixture() {
  const backlog = new TestBacklog();
  const issue = backlog.seed({ id: "alpha", number: 7, status: "In progress" });
  const identity: IssueIdentity = { backlogRepository: backlog.repository, number: issue.number, nodeId: issue.nodeId, url: issue.url };
  const requirementsHash = parseAuthoredIssueSnapshot(identity, issue.body, providers).requirementsHash;
  const read = createIssueAuthorizationReader({ backlog, providers });
  const guard = createStageAuthorization({ ticketId: "alpha", identity, requirementsHash, claimStatus: "In progress", read });
  return { backlog, identity, requirementsHash, read, guard };
}

test("the guard authorizes work while the issue stays open, claimed, and unchanged", async (t) => {
  const { guard } = fixture();
  await guard("implementation run 1 for ticket alpha");
});

test("a closed issue withdraws authorization", async (t) => {
  const { backlog, guard } = fixture();
  await backlog.closeIssueCompleted(backlog.issueNumber("alpha"));
  await assert.rejects(guard("review run 1 for ticket alpha"), (error: unknown) => {
    assert.ok(isAuthorizationWithdrawn(error));
    assert.equal(error.ticketId, "alpha");
    assert.equal(error.stage, "review run 1 for ticket alpha");
    assert.match(error.observed, /issue #7 is no longer open/);
    return true;
  });
});

test("a status the runner did not claim withdraws authorization", async (t) => {
  const { backlog, guard } = fixture();
  backlog.moveTo("alpha", "Blocked");
  await assert.rejects(guard("integration run 1 for group alpha-beta"), (error: unknown) => {
    assert.ok(error instanceof AuthorizationWithdrawnError);
    assert.match(error.observed, /its Project status is Blocked, not In progress/);
    return true;
  });
});

test("an issue that never reached the board withdraws authorization", async (t) => {
  const { backlog, guard } = fixture();
  backlog.unboard("alpha");
  await assert.rejects(guard("implementation run 1 for ticket alpha"), (error: unknown) => {
    assert.ok(error instanceof AuthorizationWithdrawnError);
    assert.match(error.observed, /its Project status is unknown, not In progress/);
    return true;
  });
});

test("rewritten requirements withdraw authorization", async (t) => {
  const { backlog, guard } = fixture();
  backlog.rewrite("alpha", "---\nid: alpha\nname: Alpha\nrepository: git@github.com:acme/app.git\nbaseBranch: main\n---\n# Alpha\n\nImplement something else entirely.\n");
  await assert.rejects(guard("publishing the draft pull request for ticket alpha"), (error: unknown) => {
    assert.ok(error instanceof AuthorizationWithdrawnError);
    assert.match(error.observed, /authored requirements changed/);
    return true;
  });
});

test("malformed replacement requirements withdraw authorization rather than failing as a work error", async () => {
  const { backlog, guard } = fixture();
  backlog.rewrite("alpha", "These requirements no longer have authored ticket metadata.");
  await assert.rejects(guard("claiming the backlog issue"), (error: unknown) => {
    assert.ok(error instanceof AuthorizationWithdrawnError);
    assert.match(error.observed, /authored requirements changed/);
    return true;
  });
});

test("a group guard stops at the first member that withdrew", async (t) => {
  const { backlog, identity, requirementsHash, read, guard } = fixture();
  backlog.seed({ id: "beta", number: 8, status: "In progress", dependencies: ["alpha"] });
  const betaIdentity: IssueIdentity = { backlogRepository: backlog.repository, number: 8, nodeId: "I_NODE_beta", url: "https://github.com/acme/tickets/issues/8" };
  const betaIssue = await backlog.getIssue(8);
  const betaGuard = createStageAuthorization({
    ticketId: "beta",
    identity: betaIdentity,
    requirementsHash: parseAuthoredIssueSnapshot(betaIdentity, betaIssue!.body, providers).requirementsHash,
    claimStatus: "In progress",
    read,
  });
  const group = createGroupAuthorization([guard, betaGuard]);
  await group("pushing branch agent-tickets/beta-abc123 for ticket beta");

  backlog.moveTo("beta", "In review");
  backlog.moveTo("alpha", "Done");
  await assert.rejects(group("pushing branch agent-tickets/beta-abc123 for ticket beta"), (error: unknown) => {
    assert.ok(error instanceof AuthorizationWithdrawnError);
    assert.equal(error.ticketId, "alpha");
    return true;
  });
});
