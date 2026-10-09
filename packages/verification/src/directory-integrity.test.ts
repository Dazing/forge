import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  copyRegularDirectory,
  makeDirectoryReadOnly,
  makeDirectoryWritable,
} from "./directory-integrity.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (path) => {
    await makeDirectoryWritable(path);
    await rm(path, { recursive: true, force: true });
  }));
});

describe("makeDirectoryReadOnly", () => {
  it("removes write permissions without making copied executables unlaunchable", async () => {
    const root = await mkdtemp(join(tmpdir(), "directory-integrity-"));
    temporaryRoots.push(root);
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(join(source, "bin"), { recursive: true });
    const executable = join(source, "bin", "application");
    const regularFile = join(source, "settings.json");
    await Promise.all([
      writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8"),
      writeFile(regularFile, "{}\n", "utf8"),
    ]);
    await Promise.all([
      chmod(executable, 0o755),
      chmod(regularFile, 0o644),
    ]);

    await copyRegularDirectory(source, destination);
    await makeDirectoryReadOnly(destination);

    expect((await stat(join(destination, "bin", "application"))).mode & 0o777).toBe(0o555);
    expect((await stat(join(destination, "settings.json"))).mode & 0o777).toBe(0o444);
  });
});
