import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import type { CommandFailure } from "../../infrastructure/git-provider/git.js";
import type { GitProviderRegistry } from "../../infrastructure/git-provider/git-provider.js";

// Ticket front-matter parsing and identity: the ticket is defined by its complete source.

const ticketIdSchema = z.string().min(1).refine((value) => value === value.trim(), "must be trimmed").refine((value) => !/[\s\p{Cc}]/u.test(value), "must not contain whitespace or control characters");
const frontMatterSchema = z
  .object({
    id: ticketIdSchema,
    name: z.string(),
    repository: z.string().trim().min(1),
    baseBranch: z.string().min(1).default("main"),
    dependsOnTickets: z.array(ticketIdSchema).default([]),
  })
  .strict()
  .superRefine((data, context) => {
    const seen = new Set<string>();
    for (const dependency of data.dependsOnTickets) {
      if (dependency === data.id) {
        context.addIssue({ code: "custom", path: ["dependsOnTickets"], message: `must not depend on itself (${data.id})` });
      }
      if (seen.has(dependency)) {
        context.addIssue({ code: "custom", path: ["dependsOnTickets"], message: `duplicate dependency ${dependency}` });
      }
      seen.add(dependency);
    }
  });

export type Ticket = Readonly<{
  id: string;
  sourceHash: string;
  requirementsHash: string;
  dependsOnTickets: readonly string[];
  name: string;
  slug: string;
  title: string;
  path: string;
  content: string;
  repository: string;
  baseBranch: string;
}>;

/** Typed ticket metadata failure carrying the source path and structured stage details for ticket diagnostics. */
export class TicketMetadataError extends Error {
  constructor(
    readonly path: string,
    readonly failure: CommandFailure,
    cause: unknown,
  ) {
    super(`Ticket metadata is invalid for ${path}: ${failure.operation} — ${failure.stderr}`, { cause });
    this.name = "TicketMetadataError";
  }
}

function metadataFailure(path: string, operation: string, detail: string): CommandFailure {
  return { operation, command: `read ${path}`, exitCode: 1, stdout: "", stderr: detail };
}

/** Drop every runner-owned lifecycle record from a body so re-annotated sources hash as their authored content. */
function authoredBody(body: string): string {
  const lines = body.split("\n");
  const authored: string[] = [];
  let skippingFactoryRecord = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("## ")) {
      const attemptRecord = /^## Attempt (\S+) \([^)]+\)$/.exec(line);
      const completionRecord = /^## Completed (\S+) \([^)]+\)$/.exec(line);
      const checkpointRecord = /^## Stage checkpoint (implement|review) \([^)]+\)$/.exec(line);
      const failureRecord = /^## Failed at stage `([^`]+)` \([^)]+\)$/.exec(line);
      const progressRecord = /^## (Retryable|Blocked) \([^)]+\)$/.exec(line);
      const publicationRecord = /^## Group publication \([^)]+\)$/.exec(line);
      const attemptId = attemptRecord?.[1] ?? completionRecord?.[1];
      const detailAttemptId = lines[index + 2]?.match(/^- Attempt ID: `([^`]+)`$/)?.[1];
      const matchesAttempt = attemptId !== undefined ? detailAttemptId === attemptId : detailAttemptId !== undefined;
      const matchesRecord = lines[index + 1] === ""
        && (progressRecord !== null
          ? lines[index + 2]?.startsWith("- Cycle: ") === true
          : publicationRecord !== null
            ? lines[index + 2]?.startsWith("- Group: `") === true
            : matchesAttempt)
        && (checkpointRecord === null || lines[index + 3] === `- Stage: \`${checkpointRecord[1]}\``)
        && (failureRecord === null || lines[index + 3] === `- Stage: \`${failureRecord[1]}\``);
      skippingFactoryRecord = (attemptRecord !== null || completionRecord !== null || checkpointRecord !== null || failureRecord !== null || progressRecord !== null || publicationRecord !== null) && matchesRecord;
    }
    if (!skippingFactoryRecord) authored.push(line);
  }
  return authored.join("\n");
}

/** Parse one complete authored ticket source. `origin` labels the source in diagnostics and becomes the ticket path; file loading stays in `loadTicket`.
 * Throws TicketMetadataError with structured stage details for any metadata violation, including a repository URL no configured provider accepts. */
export function parseTicketSource(source: string, providers: GitProviderRegistry, origin: string): Ticket {
  const ticketPath = origin;
  if (source.trim().length === 0) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket source", "Ticket is empty."), undefined);
  }

  const frontMatterMatch = source.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!frontMatterMatch) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "parsing YAML front matter", "Ticket must start with a --- delimited YAML front matter block."),
      undefined,
    );
  }
  const body = source.slice(frontMatterMatch[0].length);
  const frontMatterText = frontMatterMatch[1] ?? "";

  let frontMatter: unknown;
  try {
    frontMatter = parse(frontMatterText);
  } catch (error) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "parsing YAML front matter", error instanceof Error ? error.message : String(error)),
      error,
    );
  }

  const validated = frontMatterSchema.safeParse(frontMatter);
  if (!validated.success) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(
        ticketPath,
        "validating ticket front matter",
        validated.error.issues.map((issue) => `${issue.path.join(".") || "<front matter>"} ${issue.message}`).join("; "),
      ),
      undefined,
    );
  }

  const slug = validated.data.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (slug.length === 0) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "normalizing ticket name", `Normalized name is empty; name must contain ASCII letters, digits, or hyphens.`),
      undefined,
    );
  }

  try {
    providers.resolve(validated.data.repository);
  } catch (error) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "validating repository URL", error instanceof Error ? error.message : String(error)),
      error,
    );
  }

  return {
    id: validated.data.id,
    sourceHash: createHash("sha256").update(source).digest("hex"),
    requirementsHash: createHash("sha256").update(JSON.stringify({ ...validated.data, body: authoredBody(body) })).digest("hex"),
    dependsOnTickets: validated.data.dependsOnTickets,
    name: validated.data.name,
    slug,
    title: body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? slug,
    path: ticketPath,
    content: body,
    repository: validated.data.repository,
    baseBranch: validated.data.baseBranch,
  };
}

/** The target repository one authored source declares, read far enough to route it to the provider that validates it. Undefined when the front matter is missing, malformed, or names no repository. */
export function declaredRepository(source: string): string | undefined {
  const frontMatter = /^---\n([\s\S]*?)\n---/.exec(source);
  if (frontMatter === null) return undefined;
  let data: unknown;
  try {
    data = parse(frontMatter[1] ?? "");
  } catch {
    return undefined;
  }
  const repository = (data as { repository?: unknown } | null)?.repository;
  return typeof repository === "string" && repository.trim().length > 0 ? repository.trim() : undefined;
}
