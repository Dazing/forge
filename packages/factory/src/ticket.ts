import { createHash } from "node:crypto";
import type { AcceptanceCriterion, Ticket, TicketKind } from "./contracts.js";

const KIND_PATTERN = /^Kind:\s*(feature|bug|refactor)\s*$/im;
const ACCEPTANCE_HEADING_PATTERN = /^##\s+Acceptance criteria\s*$/im;
const CRITERION_PATTERN = /^[-*]\s+(?:\*\*)?([A-Za-z][A-Za-z0-9_-]*):(?:\*\*)?\s+(.+)$/;

export function parseTicket(path: string, markdown: string): Ticket {
  const kindMatch = KIND_PATTERN.exec(markdown);
  if (!kindMatch?.[1]) {
    throw new Error("Ticket must declare Kind: feature, bug, or refactor");
  }

  const heading = ACCEPTANCE_HEADING_PATTERN.exec(markdown);
  if (!heading) {
    throw new Error("Ticket must contain an explicit ## Acceptance criteria section");
  }

  const sectionStart = heading.index + heading[0].length;
  const remainder = markdown.slice(sectionStart);
  const nextHeading = /^##\s+/m.exec(remainder);
  const section = nextHeading ? remainder.slice(0, nextHeading.index) : remainder;
  const criteria: AcceptanceCriterion[] = [];
  const ids = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const match = CRITERION_PATTERN.exec(line.trim());
    if (!match?.[1] || !match[2]) continue;
    if (ids.has(match[1])) {
      throw new Error(`Duplicate acceptance criterion ${match[1]}`);
    }
    ids.add(match[1]);
    criteria.push({ id: match[1], text: match[2].trim() });
  }
  if (criteria.length === 0) {
    throw new Error("Acceptance criteria section must contain at least one '- ID: behavior' item");
  }

  return {
    path,
    markdown,
    digest: createHash("sha256").update(markdown).digest("hex"),
    kind: kindMatch[1] as TicketKind,
    criteria,
  };
}
