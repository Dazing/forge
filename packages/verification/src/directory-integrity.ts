import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, opendir, readlink, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface DirectoryDigest {
  readonly digest: string;
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export async function digestDirectory(
  root: string,
  options: { readonly rejectSymlinks: boolean; readonly excludes?: readonly string[] },
): Promise<DirectoryDigest> {
  const resolvedRoot = resolve(root);
  const files: { path: string; sha256: string }[] = [];
  await collectFiles(resolvedRoot, resolvedRoot, files, options.rejectSymlinks, options.excludes ?? []);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const aggregate = createHash("sha256");
  for (const file of files) {
    aggregate.update(file.path);
    aggregate.update("\0");
    aggregate.update(file.sha256);
    aggregate.update("\n");
  }
  return { digest: aggregate.digest("hex"), files };
}

export async function copyRegularDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: false });
  await copyEntries(resolve(source), resolve(source), resolve(destination));
}

export async function replaceDirectoryAtomically(source: string, destination: string): Promise<void> {
  const parent = dirname(destination);
  await assertNoSymlinkPath(parent);
  await mkdir(parent, { recursive: true });
  await assertNoSymlinkPath(parent);
  const temporary = join(parent, `.factory-copy-${process.pid}-${Date.now()}`);
  await rm(temporary, { recursive: true, force: true });
  try {
    await copyRegularDirectory(source, temporary);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function makeDirectoryReadOnly(root: string): Promise<void> {
  const directories: string[] = [];
  await makeEntriesReadOnly(root, directories);
  directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await chmod(directory, 0o555);
}

export async function makeDirectoryWritable(root: string): Promise<void> {
  let entry;
  try {
    entry = await lstat(root);
  } catch {
    return;
  }
  if (entry.isSymbolicLink()) return;
  if (entry.isDirectory()) {
    await chmod(root, 0o755);
    const directory = await opendir(root);
    for await (const child of directory) await makeDirectoryWritable(join(root, child.name));
    return;
  }
  await chmod(root, 0o644 | (entry.mode & 0o111));
}

async function collectFiles(
  root: string,
  current: string,
  files: { path: string; sha256: string }[],
  rejectSymlinks: boolean,
  excludes: readonly string[],
): Promise<void> {
  const directory = await opendir(current);
  for await (const entry of directory) {
    const absolutePath = join(current, entry.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    if (isExcluded(relativePath, excludes)) continue;
    if (entry.isSymbolicLink()) {
      if (rejectSymlinks) throw new Error(`Symbolic links are forbidden in a protected suite: ${relativePath}`);
      const target = await readlink(absolutePath);
      files.push({ path: relativePath, sha256: createHash("sha256").update(`symlink:${target}`).digest("hex") });
      continue;
    }
    if (entry.isDirectory()) {
      await collectFiles(root, absolutePath, files, rejectSymlinks, excludes);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported filesystem entry in ${root}: ${relativePath}`);
    files.push({ path: relativePath, sha256: await hashFile(absolutePath) });
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}

async function copyEntries(sourceRoot: string, source: string, destinationRoot: string): Promise<void> {
  const directory = await opendir(source);
  for await (const entry of directory) {
    const sourcePath = join(source, entry.name);
    const relativePath = relative(sourceRoot, sourcePath);
    const destinationPath = join(destinationRoot, relativePath);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in a protected suite: ${relativePath}`);
    if (entry.isDirectory()) {
      await mkdir(destinationPath);
      await copyEntries(sourceRoot, sourcePath, destinationRoot);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported filesystem entry in protected suite: ${relativePath}`);
    await copyFile(sourcePath, destinationPath);
  }
}

async function makeEntriesReadOnly(root: string, directories: string[]): Promise<void> {
  const entry = await lstat(root);
  if (entry.isSymbolicLink()) throw new Error(`Cannot protect symbolic link ${root}`);
  if (!entry.isDirectory()) {
    await chmod(root, 0o444 | (entry.mode & 0o111));
    return;
  }
  directories.push(root);
  const directory = await opendir(root);
  for await (const child of directory) await makeEntriesReadOnly(join(root, child.name), directories);
}

async function assertNoSymlinkPath(path: string): Promise<void> {
  const resolved = resolve(path);
  const parsedRoot = resolve(resolved, "/");
  const relativeParts = relative(parsedRoot, resolved).split(sep).filter(Boolean);
  let current = parsedRoot;
  for (const part of relativeParts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error(`Destination path contains a symbolic link: ${current}`);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isExcluded(path: string, excludes: readonly string[]): boolean {
  return excludes.some((excluded) => path === excluded || path.startsWith(`${excluded}/`));
}
