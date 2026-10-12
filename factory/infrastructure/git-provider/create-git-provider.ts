import { AzureDevOpsProvider } from "./azure-devops-provider.js";
import { GitHubProvider } from "./github-provider.js";
import type { Fetch, GitProvider } from "./git-provider.js";

// Provider selection for one runner invocation from the repository-root .env.

/** Select the configured provider; `fetchImpl` is a test seam and stays out of composition-root usage. */
export function createGitProvider(env: NodeJS.ProcessEnv, fetchImpl: Fetch = globalThis.fetch): GitProvider {
  const provider = env.GIT_PROVIDER;
  if (provider === "github") {
    const token = env.GITHUB_TOKEN;
    if (token === undefined || token.trim().length === 0) {
      throw new Error("GITHUB_TOKEN must be set in the repository-root .env when GIT_PROVIDER=github. See .env.example.");
    }
    return new GitHubProvider(token, fetchImpl);
  }
  if (provider === "azure-devops") {
    const pat = env.AZURE_DEVOPS_PAT;
    if (pat === undefined || pat.trim().length === 0) {
      throw new Error("AZURE_DEVOPS_PAT must be set in the repository-root .env when GIT_PROVIDER=azure-devops. See .env.example.");
    }
    return new AzureDevOpsProvider(pat, fetchImpl);
  }
  throw new Error(`GIT_PROVIDER must be github or azure-devops; got ${provider ?? "<missing>"}. See .env.example.`);
}
