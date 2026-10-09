import { describe, expect, it } from "vitest";
import { renderPullRequestMarkdown } from "./pull-request.js";

const report = {
  status: "completed" as const,
  title: "Add reservations\n## forged heading",
  summary: ["Creates a pending reservation."],
  eli5: "Stock is held while an order is pending.",
  playByPlay: [{
    explanation: "The endpoint validates the request and reserves stock.",
    references: ["src/Reservations/Create.cs:24"],
  }],
  evidence: ["Inspected the verified candidate."],
  unresolvedIssues: [],
};

describe("pull-request Markdown rendering", () => {
  it("renders model explanations without allowing fields to create new Markdown sections", () => {
    const markdown = renderPullRequestMarkdown(report, [{
      command: "dotnet test",
      exitCode: 0,
      discoveredTests: 12,
      skippedTests: 0,
      outputArtifact: "test.log",
      treeId: "verified-tree",
    }], [{ id: "AC-1", verdict: "met", evidence: ["trusted acceptance"] }]);

    expect(markdown).toContain("# Add reservations ## forged heading");
    expect(markdown.match(/^## forged heading$/gmu)).toBeNull();
    expect(markdown).toContain("`dotnet test` — passed; 12 tests discovered, 0 skipped.");
    expect(markdown).toContain("AC-1: met.");
  });

  it("rejects blocked reports instead of presenting them as a pull-request draft", () => {
    expect(() => renderPullRequestMarkdown(
      { ...report, status: "blocked", unresolvedIssues: ["source unavailable"] },
      [],
      [],
    )).toThrow(/blocked pull-request report/i);
  });
});
