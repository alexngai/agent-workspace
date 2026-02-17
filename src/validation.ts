import * as fs from 'fs/promises';
import * as path from 'path';
import { readJson, readJsonl } from './readers/json.js';
import { readMarkdown } from './readers/markdown.js';
import { readRaw } from './readers/raw.js';
import type { OutputFileSpec, OutputSpec, ValidationError, ValidationResult } from './types.js';

/** Validate that expected output files exist and pass schema / custom validation. */
export async function validateOutput(
  outputDir: string,
  spec: OutputSpec,
): Promise<ValidationResult> {
  const errors: ValidationError[] = [];

  for (const fileSpec of spec.files) {
    const fullPath = path.join(outputDir, fileSpec.path);

    // Check existence
    try {
      await fs.access(fullPath);
    } catch {
      if (fileSpec.required) {
        const desc = fileSpec.description ? ` (${fileSpec.description})` : '';
        errors.push({
          path: fileSpec.path,
          message: `Required file missing${desc}`,
        });
      }
      continue;
    }

    // Read and validate content
    try {
      const content = await readFileByFormat(outputDir, fileSpec);

      // Schema validation
      if (fileSpec.schema) {
        try {
          if (fileSpec.format === 'jsonl' && Array.isArray(content)) {
            for (const item of content) {
              fileSpec.schema.parse(item);
            }
          } else {
            fileSpec.schema.parse(content);
          }
        } catch (err) {
          errors.push({
            path: fileSpec.path,
            message: `Schema validation failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // Custom validate callback
      if (fileSpec.validate) {
        try {
          const result = await fileSpec.validate(content);
          if (result === false) {
            errors.push({
              path: fileSpec.path,
              message: 'Custom validation returned false',
            });
          }
        } catch (err) {
          errors.push({
            path: fileSpec.path,
            message: `Custom validation threw: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    } catch (err) {
      errors.push({
        path: fileSpec.path,
        message: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

async function readFileByFormat(outputDir: string, spec: OutputFileSpec): Promise<unknown> {
  switch (spec.format) {
    case 'json':
      return readJson(outputDir, spec.path);
    case 'jsonl':
      return readJsonl(outputDir, spec.path);
    case 'markdown':
      return readMarkdown(outputDir, spec.path);
    case 'raw':
      return readRaw(outputDir, spec.path);
  }
}
