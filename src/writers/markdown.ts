import * as fs from 'fs/promises';
import * as path from 'path';
import { stringify as yamlStringify } from 'yaml';
import type { MarkdownDocument } from '../types.js';

/** Write a markdown file with optional YAML frontmatter. */
export async function writeMarkdown(
  dir: string,
  filePath: string,
  doc: MarkdownDocument,
): Promise<void> {
  const fullPath = path.join(dir, filePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  let content = '';
  if (doc.frontmatter && Object.keys(doc.frontmatter).length > 0) {
    content += '---\n' + yamlStringify(doc.frontmatter).trimEnd() + '\n---\n\n';
  }
  content += doc.body;

  // Ensure trailing newline
  if (!content.endsWith('\n')) {
    content += '\n';
  }

  await fs.writeFile(fullPath, content);
}
