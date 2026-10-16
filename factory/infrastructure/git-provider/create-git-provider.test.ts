import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitProviderRegistry } from "./create-git-provider.js";
import { UnsupportedRepositoryError } from "./git-provider.js";

// A registry is built per invocation from every present target credential; resolution is per ticket repository.

const GITHUB_URL = "git@github.com:acme/app.git";
const AZURE_URL = "git@ssh.dev.azure.com:v3/contoso/web/fix-login";

function http(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, statusText: "Test", headers: { "content-type": "application/json" } });
}

test("constructs one adapter per configured target credential and routes each canonical URL to its own adapter", async () => {
  const registry = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc", AZURE_DEVOPS_PAT: "vso_pat_secret_123" });
  assert.deepEqual(registry.names, ["github", "azure-devops"]);
  const github = registry.resolve(GITHUB_URL);
  const azure = registry.resolve(AZURE_URL);
  assert.equal(github.name, "github");
  assert.equal(azure.name, "azure-devops");
  github.validateRepository(GITHUB_URL);
  azure.validateRepository(AZURE_URL);
  assert.throws(() => github.validateRepository(AZURE_URL), /git@github\.com/);
  assert.throws(() => azure.validateRepository(GITHUB_URL), /git@ssh\.dev\.azure\.com/);
});

test("a GitHub-only invocation resolves Azure work to a blocking failure naming AZURE_DEVOPS_PAT", () => {
  const registry = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc" });
  assert.deepEqual(registry.names, ["github"]);
  assert.equal(registry.resolve(GITHUB_URL).name, "github");
  assert.throws(
    () => registry.resolve(AZURE_URL),
    (error: unknown) => error instanceof UnsupportedRepositoryError
      && /AZURE_DEVOPS_PAT is not configured; Azure DevOps work is blocked/.test(error.message)
      && error.repositoryUrl === AZURE_URL
      && error.configuredProviders.length === 1 && error.configuredProviders[0] === "github"
      && !error.message.includes("gh_secret_abc"),
  );
});

test("an Azure DevOps-only invocation resolves GitHub work to a blocking failure naming GITHUB_TOKEN", () => {
  const registry = createGitProviderRegistry({ AZURE_DEVOPS_PAT: "vso_pat_secret_123" });
  assert.deepEqual(registry.names, ["azure-devops"]);
  assert.throws(
    () => registry.resolve(GITHUB_URL),
    (error: unknown) => error instanceof UnsupportedRepositoryError
      && /GITHUB_TOKEN is not configured; GitHub work is blocked/.test(error.message)
      && !error.message.includes("vso_pat_secret_123"),
  );
});

test("unsupported repository forms fail naming the URL and configured providers with zero provider HTTP calls", () => {
  let calls = 0;
  const fetchImpl = async (): Promise<Response> => {
    calls++;
    return http(500, {});
  };
  const registry = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc", AZURE_DEVOPS_PAT: "vso_pat_secret_123" }, fetchImpl);
  for (const repository of [
    "https://github.com/acme/app.git",
    "git@github.acme.com:acme/app.git",
    "git@ssh.visualstudio.com:v3/contoso/web/fix-login",
    "/srv/git/app.git",
  ]) {
    assert.throws(
      () => registry.resolve(repository),
      (error: unknown) => error instanceof UnsupportedRepositoryError
        && error.message.includes(repository)
        && error.message.includes("github") && error.message.includes("azure-devops")
        && !error.message.includes("gh_secret_abc") && !error.message.includes("vso_pat_secret_123"),
    );
  }
  assert.equal(calls, 0);
});

test("aggregated secrets carry the GitHub token, the Azure PAT, and the derived Basic value", () => {
  const registry = createGitProviderRegistry({ GITHUB_TOKEN: "gh_secret_abc", AZURE_DEVOPS_PAT: "vso_pat_secret_123" });
  const derivedBasic = Buffer.from(":vso_pat_secret_123", "utf8").toString("base64");
  assert.ok(registry.secrets.includes("gh_secret_abc"));
  assert.ok(registry.secrets.includes("vso_pat_secret_123"));
  assert.ok(registry.secrets.includes(derivedBasic));
  assert.deepEqual(registry.resolve(GITHUB_URL).secrets(), ["gh_secret_abc"]);
});

test("an invocation with no target credential fails at startup naming both variables", () => {
  assert.throws(() => createGitProviderRegistry({ OTHER_SETTING: "x" }), /GITHUB_TOKEN.*AZURE_DEVOPS_PAT|AZURE_DEVOPS_PAT.*GITHUB_TOKEN/s);
  assert.throws(() => createGitProviderRegistry({}), /GITHUB_TOKEN/);
});

test("blank target credentials count as unconfigured", () => {
  assert.throws(() => createGitProviderRegistry({ GITHUB_TOKEN: "   ", AZURE_DEVOPS_PAT: "" }), /GITHUB_TOKEN/);
  const registry = createGitProviderRegistry({ GITHUB_TOKEN: " ", AZURE_DEVOPS_PAT: "vso_pat_secret_123" });
  assert.deepEqual(registry.names, ["azure-devops"]);
});

test("resolved adapters honor an injected fetch seam", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const registry = createGitProviderRegistry({ AZURE_DEVOPS_PAT: "vso_pat_secret_123" }, async (url, init) => {
    calls.push({ url, init });
    return http(201, { pullRequestId: 42, isDraft: true, completionOptions: { mergeStrategy: "squash" } });
  });
  const created = await registry.resolve(AZURE_URL).createDraftPullRequest({
    repositoryUrl: AZURE_URL,
    title: "fix: login",
    body: "Body",
    head: "agent-tickets/fix-login-1a2b3c",
    base: "main",
    mergeStrategy: "squash",
  });
  assert.deepEqual(created, { number: 42, url: "https://dev.azure.com/contoso/web/_git/fix-login/pullrequest/42", squashPreference: "configured" });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /^https:\/\/dev\.azure\.com\/contoso\/web\/_apis\/git\/repositories\/fix-login\/pullrequests\?api-version=7\.1$/);
});
