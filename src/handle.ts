import * as path from 'path';
import { writeJson, writeJsonl } from './writers/json.js';
import { writeMarkdown } from './writers/markdown.js';
import { writeRaw, copyDir, symlink } from './writers/raw.js';
import { readJson, readJsonl, readJsonDir, type ReadJsonOptions } from './readers/json.js';
import { readMarkdown, type ReadMarkdownOptions } from './readers/markdown.js';
import { readRaw, listFiles } from './readers/raw.js';
import { validateOutput } from './validation.js';
import type { MarkdownDocument, OutputSpec, ValidationResult } from './types.js';

export class WorkspaceHandle {
  readonly id: string;
  readonly path: string;
  readonly createdAt: Date;
  private readonly dirs: string[];

  constructor(id: string, workspacePath: string, dirs: string[], createdAt: Date) {
    this.id = id;
    this.path = workspacePath;
    this.dirs = dirs;
    this.createdAt = createdAt;
  }

  /** Get the absolute path to a section directory. */
  dir(section: string): string {
    if (!this.dirs.includes(section)) {
      throw new Error(
        `Unknown section "${section}". Available: ${this.dirs.join(', ')}`,
      );
    }
    return path.join(this.path, section);
  }

  // -- Convenience accessors for default dirs --

  get inputDir(): string {
    return path.join(this.path, 'input');
  }
  get outputDir(): string {
    return path.join(this.path, 'output');
  }
  get resourcesDir(): string {
    return path.join(this.path, 'resources');
  }
  get scratchDir(): string {
    return path.join(this.path, 'scratch');
  }

  // -- Writers --

  async writeJson(section: string, filePath: string, data: unknown): Promise<void> {
    return writeJson(this.dir(section), filePath, data);
  }

  async writeJsonl(section: string, filePath: string, items: unknown[]): Promise<void> {
    return writeJsonl(this.dir(section), filePath, items);
  }

  async writeMarkdown(section: string, filePath: string, doc: MarkdownDocument): Promise<void> {
    return writeMarkdown(this.dir(section), filePath, doc);
  }

  async writeRaw(section: string, filePath: string, content: string): Promise<void> {
    return writeRaw(this.dir(section), filePath, content);
  }

  async copyDir(section: string, destName: string, srcPath: string): Promise<void> {
    return copyDir(this.dir(section), destName, srcPath);
  }

  async symlink(section: string, linkName: string, targetPath: string): Promise<void> {
    return symlink(this.dir(section), linkName, targetPath);
  }

  // -- Readers --

  async readJson<T = unknown>(
    section: string,
    filePath: string,
    options?: ReadJsonOptions<T>,
  ): Promise<T> {
    return readJson(this.dir(section), filePath, options);
  }

  async readJsonl<T = unknown>(
    section: string,
    filePath: string,
    options?: ReadJsonOptions<T>,
  ): Promise<T[]> {
    return readJsonl(this.dir(section), filePath, options);
  }

  async readMarkdown<T = Record<string, unknown>>(
    section: string,
    filePath: string,
    options?: ReadMarkdownOptions<T>,
  ): Promise<MarkdownDocument<T>> {
    return readMarkdown(this.dir(section), filePath, options);
  }

  async readRaw(section: string, filePath: string): Promise<string> {
    return readRaw(this.dir(section), filePath);
  }

  async listFiles(section: string, subPath: string = ''): Promise<string[]> {
    return listFiles(this.dir(section), subPath);
  }

  async readJsonDir<T = unknown>(
    section: string,
    subPath: string,
    options?: ReadJsonOptions<T>,
  ): Promise<Map<string, T>> {
    return readJsonDir(this.dir(section), subPath, options);
  }

  // -- Validation --

  async validateOutput(spec: OutputSpec): Promise<ValidationResult> {
    return validateOutput(this.outputDir, spec);
  }
}
