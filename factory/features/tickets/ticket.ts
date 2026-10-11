import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { CommandFailure } from "../../infrastructure/git-provider/git.js";
import type { GitProvider } from "../../infrastructure/git-provider/git-provider.js";

// Ticket front-matter parsing and identity: the ticket is defined by its complete source.

const frontMatterSchema = z
  .object({
    name: z.string(),
    repository: z.string().trim().min(1),
    baseBranch: z.string().min(1).default("main"),
  })
  .strict();

export type Ticket = Readonly<{
  id: string;
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

/** Parse exactly one ticket file; throws TicketMetadataError with structured stage details for any metadata violation, including a repository URL the selected provider rejects. */
export async function loadTicket(path: string, provider: GitProvider): Promise<Ticket> {
  const ticketPath = resolve(path);
  if (!ticketPath.toLowerCase().endsWith(".md")) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket file", "Ticket must be a Markdown file."), undefined);
  }

  let source: string;
  try {
    source = await readFile(ticketPath, "utf8");
  } catch (error) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket file", `Could not read ticket: ${ticketPath}`), error);
  }
  if (source.trim().length === 0) {
    throw new TicketMetadataError(ticketPath, metadataFailure(ticketPath, "reading ticket file", "Ticket is empty."), undefined);
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
    provider.validateRepository(validated.data.repository);
  } catch (error) {
    throw new TicketMetadataError(
      ticketPath,
      metadataFailure(ticketPath, "validating repository URL", error instanceof Error ? error.message : String(error)),
      error,
    );
  }

  return {
    id: createHash("sha256").update(source).digest("hex").slice(0, 16),
    name: validated.data.name,
    slug,
    title: body.match(/^#\s+(.+?)\s*$/m)?.[1] ?? slug,
    path: ticketPath,
    content: body,
    repository: validated.data.repository,
    baseBranch: validated.data.baseBranch,
  };
}
