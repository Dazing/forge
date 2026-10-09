import { describe, expect, it } from "vitest";
import {
  agentReportSchema,
  candidateManifestExpectationSchema,
  findingSubmissionSchema,
  type HostEvidenceBundle,
} from "./contracts.js";

describe("stage boundary contracts", () => {
  it("treats review completion and approval as separate judgments", () => {
    const report = agentReportSchema.parse({
      kind: "review",
      status: "completed",
      stage: "review",
      operation: "review",
      criteria: [{ id: "AC1", verdict: "unmet", evidence: ["finding local-1"] }],
      evidence: ["focused probe failed"],
      findings: [{
        localKey: "local-1",
        category: "correctness",
        severity: "blocking",
        criterionId: "AC1",
        location: "src/example.ts:10",
        scenario: "Invalid input is accepted",
        evidenceReferences: ["probe.log"],
        expected: "400",
        observed: "200",
      }],
      contractCompliance: "changes-required",
      implementationQuality: "changes-required",
      verdict: "changes-required",
      unresolvedIssues: ["AC1 remains unmet"],
    });

    expect(report.kind).toBe("review");
    if (report.kind !== "review") throw new Error("Expected review report");
    expect(report.status).toBe("completed");
    expect(report.verdict).toBe("changes-required");
  });

  it("requires concrete evidence for every submitted finding", () => {
    expect(findingSubmissionSchema.safeParse({
      localKey: "local-1",
      category: "correctness",
      severity: "blocking",
      scenario: "Something might fail",
      evidenceReferences: [],
    }).success).toBe(false);
  });

  it("requires explicit expectation support and ambiguity state", () => {
    expect(candidateManifestExpectationSchema.safeParse({
      criteria: ["AC1"],
      target: "case-1 step 1 status",
      provenance: { kind: "ticket", source: "AC1", rationale: "Ticket requires 201" },
      distinguishingInput: "valid request",
      expectedResult: "201",
      rejects: "returning 200",
      materialAlternative: false,
      derived: false,
      ambiguity: "resolved",
    }).success).toBe(true);

    expect(candidateManifestExpectationSchema.safeParse({
      criteria: ["AC1"],
      target: "case-1 step 1 status",
      provenance: { kind: "assumption", source: "none", rationale: "guess" },
      distinguishingInput: "valid request",
      expectedResult: "201",
      rejects: "returning 200",
      materialAlternative: true,
      ambiguity: "unresolved",
      derived: false,
    }).success).toBe(true);
  });

  it("does not misrepresent structurally complete derivation metadata as arithmetic proof", () => {
    expect(candidateManifestExpectationSchema.safeParse({
      criteria: ["AC1"],
      target: "conflict boundary",
      provenance: { kind: "ticket", source: "AC1", rationale: "Availability depends on the reservation delta." },
      distinguishingInput: "stock 10, existing reservation 4, requested quantity 9",
      expectedResult: "conflict",
      rejects: "accepting an infeasible delta",
      materialAlternative: false,
      ambiguity: "resolved",
      derived: true,
      derivation: {
        setupState: "stock 10 and existing reservation 4",
        transition: "incorrect claim: 10 - 4 = 5",
        predicate: "requested delta must not exceed available stock",
      },
    }).success).toBe(true);
  });

  it("represents host evidence with sandbox-readable artifact references", () => {
    const bundle: HostEvidenceBundle = {
      schemaVersion: 1,
      runId: "run-1",
      operationId: "implementation-1",
      originatingStage: "implementation",
      attemptId: "implementation-1",
      provenance: "host-observed",
      treeId: "tree-1",
      suite: { version: "suite-1", digest: "digest-1" },
      checks: [{
        command: "unit-tests",
        outcome: "failed",
        exitCode: 1,
        outputArtifact: { id: "check-1", path: "/home/agent/factory-inputs/evidence/check-1.log", mediaType: "text/plain" },
        decisiveExcerpt: "expected 2, received 1",
        treeId: "tree-1",
        acceptanceDigest: "digest-1",
      }],
      decisions: [],
      outstandingFindings: [],
      reportReferences: [],
    };

    expect(bundle.checks[0]?.outputArtifact?.path).toContain("/factory-inputs/evidence/");
  });
});
