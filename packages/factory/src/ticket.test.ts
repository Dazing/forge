import { describe, expect, it } from "vitest";
import { parseTicket } from "./ticket.js";

describe("parseTicket", () => {
  it("extracts stable criterion identifiers and task kind", () => {
    const ticket = parseTicket("ticket.md", `# Reserve stock\n\nKind: feature\n\n## Acceptance criteria\n- AC-1: A reservation reduces available stock.\n- AC-2: Over-reservation returns 409.\n`);

    expect(ticket.kind).toBe("feature");
    expect(ticket.criteria).toEqual([
      { id: "AC-1", text: "A reservation reduces available stock." },
      { id: "AC-2", text: "Over-reservation returns 409." },
    ]);
    expect(ticket.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a ticket without explicit acceptance criteria", () => {
    expect(() => parseTicket("ticket.md", "# Do something\n\nKind: bug\n")).toThrow(/Acceptance criteria/);
  });

  it("rejects duplicate criterion identifiers", () => {
    expect(() => parseTicket("ticket.md", `# Duplicate\nKind: refactor\n## Acceptance criteria\n- AC-1: one\n- AC-1: two\n`)).toThrow(/Duplicate acceptance criterion AC-1/);
  });
});
