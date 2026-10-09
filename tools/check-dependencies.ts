import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import * as ts from "typescript";

const ALLOWED_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  factory: [],
  "execution-backend": ["factory"],
  "git-workspace": ["factory"],
  verification: ["factory"],
  "orchestration-supervisor": ["factory"],
  "run-artifacts": ["factory"],
  "factory-cli": ["factory", "execution-backend", "git-workspace", "verification", "run-artifacts", "orchestration-supervisor"],
};

export interface DependencyViolation {
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
}

export async function findDependencyViolations(root: string): Promise<readonly DependencyViolation[]> {
  const sourceRoots = [resolve(root, "packages"), resolve(root, "apps")];
  const files: string[] = [];
  for (const sourceRoot of sourceRoots) {
    await collectTypeScriptFiles(sourceRoot, files);
  }
  const violations: DependencyViolation[] = [];
  for (const file of files) {
    const owner = ownerFromPath(root, file);
    if (!owner) continue;
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      const target = packageFromSpecifier(root, file, specifier);
      if (!target || target === owner) continue;
      if (!ALLOWED_DEPENDENCIES[owner]?.includes(target)) {
        violations.push({ file: relative(root, file), specifier, reason: `${owner} must not depend on ${target}` });
      } else if (specifier.startsWith("@factory/") && specifier.split("/").length > 2) {
        violations.push({ file: relative(root, file), specifier, reason: "Deep package imports are forbidden" });
      }
    }
  }
  return violations;
}

async function collectTypeScriptFiles(directory: string, files: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectTypeScriptFiles(path, files);
    else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
  }
}

function ownerFromPath(root: string, file: string): string | undefined {
  const parts = relative(root, file).split(sep);
  if (parts[0] === "packages") return parts[1];
  if (parts[0] === "apps" && parts[1] === "factory-cli") return "factory-cli";
  return undefined;
}

function packageFromSpecifier(root: string, file: string, specifier: string): string | undefined {
  if (specifier.startsWith("@factory/")) {
    const packageName = specifier.slice("@factory/".length).split("/")[0];
    return packageName === "core" ? "factory" : packageName;
  }
  if (!specifier.startsWith(".")) return undefined;
  const target = resolve(file, "..", specifier);
  return ownerFromPath(root, target);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const violations = await findDependencyViolations(process.cwd());
  if (violations.length > 0) {
    for (const violation of violations) console.error(`${violation.file}: ${violation.reason} (${violation.specifier})`);
    process.exitCode = 1;
  }
}
