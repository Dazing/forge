import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitProvider } from "./create-git-provider.js";

test("selects the GitHub provider with its token", () => {
  const provider = createGitProvider({ GIT_PROVIDER: "github", GITHUB_TOKEN: "gh_secret_abc" });
  assert.equal(provider.name, "github");
  assert.equal(provider.credential, "gh_secret_abc");
});

test("selects the Azure DevOps provider with its PAT", () => {
  const provider = createGitProvider({ GIT_PROVIDER: "azure-devops", AZURE_DEVOPS_PAT: "vso_pat_secret_123" });
  assert.equal(provider.name, "azure-devops");
  assert.equal(provider.credential, "vso_pat_secret_123");
});

test("rejects an unsupported provider", () => {
  assert.throws(() => createGitProvider({ GIT_PROVIDER: "gitlab", GITHUB_TOKEN: "gh_secret_abc" }), /github or azure-devops/);
  assert.throws(() => createGitProvider({ GITHUB_TOKEN: "gh_secret_abc" }), /github or azure-devops/);
});

test("rejects a missing provider credential", () => {
  assert.throws(() => createGitProvider({ GIT_PROVIDER: "github" }), /GITHUB_TOKEN/);
  assert.throws(() => createGitProvider({ GIT_PROVIDER: "azure-devops" }), /AZURE_DEVOPS_PAT/);
});

test("rejects a blank provider credential", () => {
  assert.throws(() => createGitProvider({ GIT_PROVIDER: "github", GITHUB_TOKEN: "   " }), /GITHUB_TOKEN/);
  assert.throws(() => createGitProvider({ GIT_PROVIDER: "azure-devops", AZURE_DEVOPS_PAT: " " }), /AZURE_DEVOPS_PAT/);
});

test("the injected fetch seam reaches provider requests without network access", async () => {
  const calls: string[] = [];
  const provider = createGitProvider({ GIT_PROVIDER: "azure-devops", AZURE_DEVOPS_PAT: "vso_pat_secret_123" }, async (url, init) => {
    calls.push(`${init.method} ${url}`);
    return new Response(JSON.stringify({ pullRequestId: 22 }), { status: 201 });
  });

  const result = await provider.createDraftPullRequest({
    repositoryUrl: "git@ssh.dev.azure.com:v3/contoso/web/fix-login",
    head: "agent-tickets/fix-login-1a2b3c",
    base: "main",
    title: "Fix login redirect",
    body: "Body.",
  });

  assert.deepEqual(calls, ["POST https://dev.azure.com/contoso/web/_apis/git/repositories/fix-login/pullrequests?api-version=7.1"]);
  assert.deepEqual(result, { number: 22, url: "https://dev.azure.com/contoso/web/_git/fix-login/pullrequest/22" });
});
