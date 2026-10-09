import { opencode, Output, run } from "@ai-hero/sandcastle";
import { docker, type DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { stageReportSchema } from "@factory/core";
import type {
  ExecutionBackendConfig,
  RunnerInvocation,
  RunnerResult,
  SandcastleAttemptRunner,
} from "./execution-backend.js";

const VLLM_PROVIDER_ID = "factory-vllm";

export class SandcastleRunner implements SandcastleAttemptRunner {
  readonly #config: ExecutionBackendConfig;

  constructor(config: ExecutionBackendConfig) {
    this.#config = config;
  }

  async run(invocation: RunnerInvocation): Promise<RunnerResult> {
    const environment = buildOpenCodeEnvironment(this.#config);
    const dockerOptions: DockerOptions = {
      imageName: this.#config.imageName,
      mounts: invocation.mounts,
      ...(this.#config.network === undefined ? {} : { network: this.#config.network }),
      ...(this.#config.containerUid === undefined ? {} : { containerUid: this.#config.containerUid }),
      ...(this.#config.containerGid === undefined ? {} : { containerGid: this.#config.containerGid }),
    };
    const result = await run({
      agent: opencode(`${VLLM_PROVIDER_ID}/${this.#config.modelId}`, {
        agent: "build",
        env: environment,
      }),
      sandbox: docker(dockerOptions),
      cwd: invocation.workspacePath,
      branchStrategy: invocation.branchStrategy,
      prompt: invocation.prompt,
      maxIterations: 1,
      output: Output.object({
        tag: "stage_report",
        schema: stageReportSchema,
        maxRetries: 0,
      }),
      signal: invocation.signal,
      logging: {
        type: "file",
        path: invocation.transcriptPath,
        verbose: false,
      },
      name: invocation.sessionId,
      idleTimeoutSeconds: this.#config.idleTimeoutSeconds ?? 600,
    });

    const runtimeSessionId = result.iterations.at(-1)?.sessionId;
    return {
      report: result.output,
      evidence: [result.logFilePath ?? invocation.transcriptPath],
      ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    };
  }
}

function buildOpenCodeEnvironment(config: ExecutionBackendConfig): Record<string, string> {
  const providerOptions: Record<string, string> = {
    baseURL: config.endpoint,
    apiKey: "local-vllm",
  };

  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: `${VLLM_PROVIDER_ID}/${config.modelId}`,
      small_model: `${VLLM_PROVIDER_ID}/${config.modelId}`,
      autoupdate: false,
      share: "disabled",
      enabled_providers: [VLLM_PROVIDER_ID],
      provider: {
        [VLLM_PROVIDER_ID]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Factory vLLM",
          options: providerOptions,
          models: {
            [config.modelId]: {
              name: config.modelId,
            },
          },
        },
      },
    }),
  };
}
