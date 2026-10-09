import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { opencode, Output, run } from "@ai-hero/sandcastle";
import { docker, type DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { pullRequestReportSchema, stageReportSchema } from "@factory/core";
import type {
  ExecutionBackendConfig,
  RunnerInvocation,
  RunnerResult,
  ScratchMount,
  SandcastleAttemptRunner,
} from "./execution-backend.js";

const OPENAI_PROVIDER_ID = "openai";
const OPENCODE_AUTH_PATH = "/home/agent/.local/share/opencode/auth.json";
const OPENCODE_REASONING_VARIANT = "medium";
const execFileAsync = promisify(execFile);

export class SandcastleRunner implements SandcastleAttemptRunner {
  readonly #config: ExecutionBackendConfig;

  constructor(config: ExecutionBackendConfig) {
    this.#config = config;
  }

  async canRemoveScratch(scratch: ScratchMount): Promise<boolean> {
    // Sandcastle 0.12 ignores Docker stop/rm failures. Settlement alone cannot authorize deletion.
    const options = { encoding: "utf8" as const, timeout: 10_000, maxBuffer: 1024 * 1024 };
    const { stdout } = await execFileAsync("docker", ["ps", "--quiet", "--no-trunc"], options);
    const containerIds = stdout.trim().split(/\s+/).filter(Boolean);
    if (containerIds.length === 0) return true;
    const inspection = await execFileAsync("docker", ["inspect", ...containerIds], options);
    const containers: unknown = JSON.parse(inspection.stdout);
    if (!Array.isArray(containers) || containers.length !== containerIds.length) return false;
    return containers.every((container: unknown) => {
      if (container === null || typeof container !== "object" || !("Mounts" in container)
        || !Array.isArray(container.Mounts)) return false;
      return container.Mounts.every((mount: unknown) =>
        mount !== null && typeof mount === "object" && "Source" in mount
        && typeof mount.Source === "string" && mount.Source !== scratch.hostPath);
    });
  }

  async run(invocation: RunnerInvocation): Promise<RunnerResult> {
    await validateOpenAiSubscriptionAuth(this.#config.authFile);
    const environment = buildOpenCodeEnvironment(this.#config);
    const dockerOptions: DockerOptions = {
      imageName: this.#config.imageName,
      mounts: [
        ...invocation.mounts,
        invocation.scratch,
        { hostPath: this.#config.authFile, sandboxPath: OPENCODE_AUTH_PATH, readonly: false },
      ],
      ...(this.#config.network === undefined ? {} : { network: this.#config.network }),
      ...(this.#config.containerUid === undefined ? {} : { containerUid: this.#config.containerUid }),
      ...(this.#config.containerGid === undefined ? {} : { containerGid: this.#config.containerGid }),
    };
    const result = await run({
      agent: opencode(`${OPENAI_PROVIDER_ID}/${this.#config.modelId}`, {
        agent: "build",
        variant: OPENCODE_REASONING_VARIANT,
        env: environment,
      }),
      sandbox: docker(dockerOptions),
      cwd: invocation.workspacePath,
      branchStrategy: invocation.branchStrategy,
      prompt: invocation.prompt,
      maxIterations: 1,
      output: invocation.kind === "stage"
        ? Output.object({
            tag: "stage_report",
            schema: stageReportSchema,
            maxRetries: 0,
          })
        : Output.object({
            tag: "pull_request_report",
            schema: pullRequestReportSchema,
            maxRetries: 0,
          }),
      signal: invocation.signal,
      logging: {
        type: "file",
        path: invocation.transcriptPath,
        verbose: false,
        onAgentStreamEvent: () => invocation.onAgentActivity?.(),
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
  return {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: `${OPENAI_PROVIDER_ID}/${config.modelId}`,
      small_model: `${OPENAI_PROVIDER_ID}/${config.modelId}`,
      autoupdate: false,
      share: "disabled",
      enabled_providers: [OPENAI_PROVIDER_ID],
      permission: {
        skill: {
          "*": "allow",
        },
      },
    }),
  };
}

async function validateOpenAiSubscriptionAuth(path: string): Promise<void> {
  const metadata = await stat(path).catch((error: unknown) => {
    throw new Error(`Cannot read the OpenCode subscription auth file at ${path}.`, { cause: error });
  });
  if (!metadata.isFile()) {
    throw new Error(`OpenCode subscription auth path ${path} must be a regular file.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(`OpenCode subscription auth file ${path} must not be accessible by group or other users.`);
  }

  let auth: unknown;
  try {
    auth = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`OpenCode subscription auth file ${path} must contain valid JSON.`, { cause: error });
  }
  if (auth === null || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error(`OpenCode subscription auth file ${path} must contain an OpenCode auth object.`);
  }
  const entries = Object.entries(auth);
  if (entries.length !== 1 || entries[0]?.[0] !== OPENAI_PROVIDER_ID) {
    throw new Error(
      `OpenCode subscription auth file ${path} must be dedicated to the OpenAI provider.`,
    );
  }
  const credential: unknown = entries[0][1];
  if (
    credential === null
    || typeof credential !== "object"
    || !("type" in credential)
    || credential.type !== "oauth"
    || !("refresh" in credential)
    || typeof credential.refresh !== "string"
    || credential.refresh.length === 0
    || !("access" in credential)
    || typeof credential.access !== "string"
    || credential.access.length === 0
    || !("expires" in credential)
    || typeof credential.expires !== "number"
  ) {
    throw new Error(
      `OpenCode subscription auth file ${path} must contain an OpenAI OAuth credential from ChatGPT Plus/Pro login.`,
    );
  }
}
