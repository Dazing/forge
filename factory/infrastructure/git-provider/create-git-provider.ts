import { AzureDevOpsProvider, azureDevOpsBranchUrl, isAzureDevOpsRepositoryUrl } from "./azure-devops-provider.js";
import { GitHubProvider, githubBranchUrl, isGitHubRepositoryUrl } from "./github-provider.js";
import { UnsupportedRepositoryError } from "./git-provider.js";
import type { Fetch, GitProvider, GitProviderRegistry, ProviderName } from "./git-provider.js";

// Provider registry for one runner invocation, built from the repository-root .env.
// Every target credential that is present constructs its adapter; tickets resolve per repository.

interface TargetProvider {
  readonly name: ProviderName;
  readonly label: string;
  readonly credentialVariable: string;
  acceptsRepository(repositoryUrl: string): boolean;
  construct(credential: string, fetchImpl: Fetch): GitProvider;
}

const TARGET_PROVIDERS: readonly TargetProvider[] = [
  {
    name: "github",
    label: "GitHub",
    credentialVariable: "GITHUB_TOKEN",
    acceptsRepository: isGitHubRepositoryUrl,
    construct: (credential, fetchImpl) => new GitHubProvider(credential, fetchImpl),
  },
  {
    name: "azure-devops",
    label: "Azure DevOps",
    credentialVariable: "AZURE_DEVOPS_PAT",
    acceptsRepository: isAzureDevOpsRepositoryUrl,
    construct: (credential, fetchImpl) => new AzureDevOpsProvider(credential, fetchImpl),
  },
];

/** Browser-facing link to one branch of a canonical target repository, in the owning provider's web form; undefined for any other URL. */
export function branchBrowserUrl(repositoryUrl: string, branch: string): string | undefined {
  return githubBranchUrl(repositoryUrl, branch) ?? azureDevOpsBranchUrl(repositoryUrl, branch);
}

/** Construct the registry of every target provider with a usable credential; `fetchImpl` is a test seam and stays out of composition-root usage. */
export function createGitProviderRegistry(env: NodeJS.ProcessEnv, fetchImpl: Fetch = globalThis.fetch): GitProviderRegistry {
  const configured = TARGET_PROVIDERS
    .map((target) => ({ target, credential: env[target.credentialVariable]?.trim() ?? "" }))
    .filter((entry) => entry.credential.length > 0);
  if (configured.length === 0) {
    throw new Error(
      "At least one target credential must be set in the repository-root .env: GITHUB_TOKEN for GitHub work, AZURE_DEVOPS_PAT for Azure DevOps work. See .env.example.",
    );
  }

  const adapters = configured.map((entry) => entry.target.construct(entry.credential, fetchImpl));
  const names = configured.map((entry) => entry.target.name);
  const secrets = adapters.flatMap((adapter) => adapter.secrets());

  function resolve(repositoryUrl: string): GitProvider {
    for (const adapter of adapters) {
      try {
        adapter.validateRepository(repositoryUrl);
        return adapter;
      } catch {
        // Not this adapter's canonical SSH form; the next configured adapter is tried.
      }
    }
    const unavailable = TARGET_PROVIDERS.find(
      (target) => !names.includes(target.name) && target.acceptsRepository(repositoryUrl),
    );
    const message = unavailable === undefined
      ? `Repository ${repositoryUrl} is not a canonical SSH URL accepted by the configured providers (${names.join(", ")}).`
      : `Repository ${repositoryUrl} requires the ${unavailable.label} provider, but ${unavailable.credentialVariable} is not configured; ${unavailable.label} work is blocked. Configured providers: ${names.join(", ")}.`;
    throw new UnsupportedRepositoryError(repositoryUrl, names, message);
  }

  return { names, secrets, resolve };
}
