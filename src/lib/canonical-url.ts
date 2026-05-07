/**
 * Canonical git-remote-URL utility.
 *
 * Federation-friendly identity for repos: every comparison, lookup, and merge
 * operation goes through `canonicalizeRepoUrl()` so the rule lives in one place.
 *
 * Canonical form: `https://{host}/{owner}/{repo}` — lowercase, no `.git` suffix,
 * no trailing slash, no query/fragment, port preserved only for non-default
 * (i.e., not 443/22/80) self-hosted setups.
 *
 * See `references/agent-workspace/docs/design/repo-kind.md` for design rationale.
 */

import gitUrlParse from 'git-url-parse';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CanonicalRepoIdentity {
  /** Canonical URL form, e.g. `'https://github.com/acme/foo'`. The federation key. */
  canonicalUrl: string;
  /** Bare hostname (no port), e.g. `'github.com'`. */
  host: string;
  /** Owner / organization, e.g. `'acme'`. May contain slashes for GitLab subgroups. */
  owner: string;
  /** Repo name, e.g. `'foo'`. `.git` suffix stripped. */
  name: string;
}

export interface RepoIdentityConfig {
  /**
   * Hosts on which owner/name casing should be preserved.
   * GitHub is case-insensitive (`Acme/Foo` ≡ `acme/foo`); some self-hosted
   * GitLab installations are case-sensitive — opt those hosts in here.
   */
  caseSensitiveHosts?: string[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Thrown by {@link canonicalizeRepoUrl} on malformed or non-URL input.
 *
 * Use {@link tryCanonicalizeRepoUrl} for the "I have a maybe-URL" case.
 */
export class InvalidRepoUrlError extends Error {
  readonly code = 'invalid_url' as const;

  constructor(
    public readonly input: string,
    public readonly reason: string,
  ) {
    super(`Invalid repo URL ${JSON.stringify(input)}: ${reason}`);
    this.name = 'InvalidRepoUrlError';
  }
}

// ── Module-level configuration ────────────────────────────────────────────────

let moduleConfig: RepoIdentityConfig = {};

/**
 * Set process-global canonicalization config. Call once at process startup;
 * per-call overrides are deliberately not supported to prevent canonical-URL
 * drift between code paths.
 */
export function setRepoIdentityConfig(config: RepoIdentityConfig): void {
  moduleConfig = { ...config };
}

/** Read the current canonicalization config (frozen). */
export function getRepoIdentityConfig(): Readonly<RepoIdentityConfig> {
  return Object.freeze({ ...moduleConfig });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Canonicalize a git remote URL into the federation-friendly form.
 *
 * Throws {@link InvalidRepoUrlError} on malformed input. Use
 * {@link tryCanonicalizeRepoUrl} when input may not be a URL.
 *
 * @example
 * canonicalizeRepoUrl('git@github.com:Foo/Bar.git')
 * // → { canonicalUrl: 'https://github.com/foo/bar', host: 'github.com', owner: 'foo', name: 'bar' }
 */
export function canonicalizeRepoUrl(input: string): CanonicalRepoIdentity {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new InvalidRepoUrlError(input ?? '', 'Input must be a non-empty string');
  }

  const trimmed = input.trim();
  let parsed: ReturnType<typeof gitUrlParse>;
  try {
    parsed = gitUrlParse(trimmed);
  } catch (err) {
    throw new InvalidRepoUrlError(
      trimmed,
      err instanceof Error ? err.message : String(err),
    );
  }

  if (parsed.parse_failed || !parsed.host || !parsed.owner || !parsed.name) {
    throw new InvalidRepoUrlError(trimmed, 'Missing host, owner, or name after parsing');
  }

  // git-url-parse's `host` field is `<hostname>` or `<hostname>:<port>` and
  // already strips default ports (22, 443). Preserve as-is for the URL but
  // split off the port for caseSensitiveHosts matching.
  const fullHost = parsed.host.toLowerCase();
  const bareHost = fullHost.split(':')[0]!;

  const caseSensitive = moduleConfig.caseSensitiveHosts?.includes(bareHost) ?? false;

  // Owner may contain slashes for GitLab subgroups (`group/subgroup`).
  const owner = caseSensitive ? parsed.owner : parsed.owner.toLowerCase();
  const name = (caseSensitive ? parsed.name : parsed.name.toLowerCase()).replace(/\.git$/, '');

  const canonicalUrl = `https://${fullHost}/${owner}/${name}`;

  return { canonicalUrl, host: bareHost, owner, name };
}

/**
 * Canonicalize-or-null variant. Returns `null` on malformed input instead of
 * throwing. Use for "maybe-URL" checks where invalid input is expected.
 */
export function tryCanonicalizeRepoUrl(input: string): CanonicalRepoIdentity | null {
  try {
    return canonicalizeRepoUrl(input);
  } catch {
    return null;
  }
}

/**
 * Fuzzy match — true iff both inputs canonicalize to the same URL. Useful
 * for duplicate-detection UIs.
 */
export function isSimilarRepoUrl(a: string, b: string): boolean {
  const aId = tryCanonicalizeRepoUrl(a);
  const bId = tryCanonicalizeRepoUrl(b);
  if (!aId || !bId) return false;
  return aId.canonicalUrl === bId.canonicalUrl;
}
