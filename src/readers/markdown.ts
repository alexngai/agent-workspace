import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as yamlParse } from 'yaml';
import type { MarkdownDocument, Schema } from '../types.js';

export interface ReadMarkdownOptions<T = Record<string, unknown>> {
  /** Schema to validate/parse the frontmatter. */
  frontmatterSchema?: Schema<T>;
}

/** Read a markdown file, parsing YAML frontmatter if present. */
export async function readMarkdown<T = Record<string, unknown>>(
  dir: string,
  filePath: string,
  options?: ReadMarkdownOptions<T>,
): Promise<MarkdownDocument<T>> {
  const fullPath = path.join(dir, filePath);
  const raw = await fs.readFile(fullPath, 'utf-8');

  const match = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);

  let frontmatter: T;
  let body: string;

  if (match) {
    const parsed = yamlParse(match[1]);
    frontmatter = options?.frontmatterSchema ? options.frontmatterSchema.parse(parsed) : parsed;
    body = match[2];
  } else {
    frontmatter = (options?.frontmatterSchema
      ? options.frontmatterSchema.parse({})
      : {}) as T;
    body = raw;
  }

  return { frontmatter, body };
}
