import * as fs from 'fs/promises';
import * as path from 'path';

/** Write raw string content to a file. */
export async function writeRaw(dir: string, filePath: string, content: string): Promise<void> {
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
}

/** Recursively copy a directory into the workspace. */
export async function copyDir(dir: string, destName: string, srcPath: string): Promise<void> {
  const fullDest = path.join(dir, destName);
  await fs.cp(srcPath, fullDest, { recursive: true });
}

/** Create a symlink inside the workspace pointing to an external path. */
export async function symlink(dir: string, linkName: string, targetPath: string): Promise<void> {
  const fullLink = path.join(dir, linkName);
  await fs.mkdir(path.dirname(fullLink), { recursive: true });
  await fs.symlink(targetPath, fullLink);
}
