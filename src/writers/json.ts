import * as fs from 'fs/promises';
import * as path from 'path';

/** Write a JSON file (pretty-printed). */
export async function writeJson(dir: string, filePath: string, data: unknown): Promise<void> {
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, JSON.stringify(data, null, 2) + '\n');
}

/** Write a JSONL file (one JSON object per line). */
export async function writeJsonl(dir: string, filePath: string, items: unknown[]): Promise<void> {
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const content = items.map((item) => JSON.stringify(item)).join('\n') + '\n';
  await fs.writeFile(fullPath, content);
}
