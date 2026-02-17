import * as fs from 'fs/promises';
import * as path from 'path';
import type { Schema } from '../types.js';

export interface ReadJsonOptions<T = unknown> {
  schema?: Schema<T>;
}

/** Read and parse a JSON file. Optionally validate against a schema. */
export async function readJson<T = unknown>(
  dir: string,
  filePath: string,
  options?: ReadJsonOptions<T>,
): Promise<T> {
  const fullPath = path.join(dir, filePath);
  const raw = await fs.readFile(fullPath, 'utf-8');
  const data = JSON.parse(raw);

  if (options?.schema) {
    return options.schema.parse(data);
  }

  return data as T;
}

/** Read a JSONL file and return an array of parsed objects. Optionally validate each item. */
export async function readJsonl<T = unknown>(
  dir: string,
  filePath: string,
  options?: ReadJsonOptions<T>,
): Promise<T[]> {
  const fullPath = path.join(dir, filePath);
  const raw = await fs.readFile(fullPath, 'utf-8');
  const lines = raw.trimEnd().split('\n').filter((line) => line.length > 0);

  return lines.map((line, index) => {
    const data = JSON.parse(line);
    if (options?.schema) {
      try {
        return options.schema.parse(data);
      } catch (err) {
        throw new Error(
          `JSONL validation failed at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return data as T;
  });
}

/**
 * Read all JSON files in a directory, returning a Map of filename → parsed content.
 * Optionally validate each file against a schema.
 */
export async function readJsonDir<T = unknown>(
  dir: string,
  subPath: string,
  options?: ReadJsonOptions<T>,
): Promise<Map<string, T>> {
  const fullDir = path.join(dir, subPath);
  const entries = await fs.readdir(fullDir);
  const result = new Map<string, T>();

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const data = await readJson<T>(fullDir, entry, options);
    result.set(entry, data);
  }

  return result;
}
