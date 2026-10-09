import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findDependencyViolations } from "../../tools/check-dependencies.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("package dependency rules", () => {
  it("rejects an adapter-to-adapter import", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-boundaries-"));
    temporaryRoots.push(root);
    const source = join(root, "packages", "verification", "src");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "bad.ts"), 'import "../../git-workspace/src/index.js";\n');

    const violations = await findDependencyViolations(root);

    expect(violations).toEqual([expect.objectContaining({ reason: "verification must not depend on git-workspace" })]);
  });

  it("allows adapters to import only the factory public package", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-boundaries-"));
    temporaryRoots.push(root);
    const source = join(root, "packages", "verification", "src");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "good.ts"), 'import type { VerificationPort } from "@factory/core";\n');

    await expect(findDependencyViolations(root)).resolves.toEqual([]);
  });
});
