import * as fs from 'fs/promises';
import * as path from 'path';

/** Read a file as a raw string. */
export async function readRaw(dir: string, filePath: string): Promise<string> {
  const fullPath = path.join(dir, filePath);
  return fs.readFile(fullPath, 'utf-8');
}

/** List files in a section subdirectory, returning paths relative to the directory. */
export async function listFiles(dir: string, subPath: string = ''): Promise<string[]> {
  const fullDir = path.join(dir, subPath);
  const entries = await fs.readdir(fullDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const relative = path.join(subPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFiles(dir, relative);
      files.push(...nested);
    } else {
      files.push(relative);
    }
  }

  return files;
}
