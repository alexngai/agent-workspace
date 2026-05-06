import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  canonicalizeRepoUrl,
  tryCanonicalizeRepoUrl,
  isSimilarRepoUrl,
  setRepoIdentityConfig,
  getRepoIdentityConfig,
  InvalidRepoUrlError,
} from '../../src/lib/canonical-url.js';

describe('canonicalizeRepoUrl — basic shape', () => {
  it('produces canonical https://{host}/{owner}/{name} for plain HTTPS input', () => {
    const result = canonicalizeRepoUrl('https://github.com/acme/foo');
    expect(result.canonicalUrl).toBe('https://github.com/acme/foo');
    expect(result.host).toBe('github.com');
    expect(result.owner).toBe('acme');
    expect(result.name).toBe('foo');
  });
});

describe('canonicalizeRepoUrl — edge case matrix from repo-kind.md', () => {
  it('SSH ↔ HTTPS produce the same canonical URL', () => {
    const ssh = canonicalizeRepoUrl('git@github.com:foo/bar');
    const https = canonicalizeRepoUrl('https://github.com/foo/bar');
    expect(ssh.canonicalUrl).toBe(https.canonicalUrl);
  });

  it('strips trailing .git suffix', () => {
    const result = canonicalizeRepoUrl('https://github.com/foo/bar.git');
    expect(result.canonicalUrl).toBe('https://github.com/foo/bar');
    expect(result.name).toBe('bar');
  });

  it('strips trailing slash', () => {
    const result = canonicalizeRepoUrl('https://github.com/foo/bar/');
    expect(result.canonicalUrl).toBe('https://github.com/foo/bar');
  });

  it('strips query and fragment', () => {
    const result = canonicalizeRepoUrl('https://github.com/foo/bar?ref=main#L1');
    expect(result.canonicalUrl).toBe('https://github.com/foo/bar');
  });

  it('maps git:// protocol to https://', () => {
    const result = canonicalizeRepoUrl('git://github.com/foo/bar');
    expect(result.canonicalUrl).toBe('https://github.com/foo/bar');
  });

  it('preserves non-default ports for self-hosted', () => {
    const result = canonicalizeRepoUrl('https://gitlab.corp.com:8443/foo/bar');
    expect(result.canonicalUrl).toBe('https://gitlab.corp.com:8443/foo/bar');
    expect(result.host).toBe('gitlab.corp.com');
  });

  it('strips default port 443', () => {
    const result = canonicalizeRepoUrl('https://github.com:443/foo/bar');
    expect(result.canonicalUrl).toBe('https://github.com/foo/bar');
  });

  it('lowercases host on case-insensitive default', () => {
    const result = canonicalizeRepoUrl('https://Github.com/Foo/Bar');
    expect(result.canonicalUrl).toBe('https://github.com/foo/bar');
    expect(result.host).toBe('github.com');
    expect(result.owner).toBe('foo');
    expect(result.name).toBe('bar');
  });

  it('preserves owner/name casing when host is in caseSensitiveHosts', () => {
    setRepoIdentityConfig({ caseSensitiveHosts: ['gitlab.corp.com'] });
    const result = canonicalizeRepoUrl('https://gitlab.corp.com/Group/Repo');
    expect(result.host).toBe('gitlab.corp.com');
    expect(result.owner).toBe('Group');
    expect(result.name).toBe('Repo');
    expect(result.canonicalUrl).toBe('https://gitlab.corp.com/Group/Repo');
  });

  it('lowercases host even when host is in caseSensitiveHosts', () => {
    setRepoIdentityConfig({ caseSensitiveHosts: ['gitlab.corp.com'] });
    const result = canonicalizeRepoUrl('https://Gitlab.Corp.Com/Group/Repo');
    expect(result.host).toBe('gitlab.corp.com');
  });

  it('handles GitLab subgroups (owner contains slashes)', () => {
    const result = canonicalizeRepoUrl('https://gitlab.com/group/subgroup/repo');
    expect(result.canonicalUrl).toBe('https://gitlab.com/group/subgroup/repo');
    expect(result.owner).toBe('group/subgroup');
    expect(result.name).toBe('repo');
  });
});

describe('canonicalizeRepoUrl — invalid input', () => {
  it('throws InvalidRepoUrlError on empty string', () => {
    expect(() => canonicalizeRepoUrl('')).toThrow(InvalidRepoUrlError);
  });

  it('throws InvalidRepoUrlError on whitespace-only string', () => {
    expect(() => canonicalizeRepoUrl('   ')).toThrow(InvalidRepoUrlError);
  });

  it('throws InvalidRepoUrlError on garbage input', () => {
    expect(() => canonicalizeRepoUrl('not a url')).toThrow(InvalidRepoUrlError);
  });

  it('error includes the original input and a reason', () => {
    try {
      canonicalizeRepoUrl('not a url');
      expect.fail('Expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidRepoUrlError);
      expect((err as InvalidRepoUrlError).input).toBe('not a url');
      expect((err as InvalidRepoUrlError).reason).toBeTypeOf('string');
      expect((err as InvalidRepoUrlError).code).toBe('invalid_url');
    }
  });
});

describe('tryCanonicalizeRepoUrl', () => {
  it('returns the identity on valid input', () => {
    const result = tryCanonicalizeRepoUrl('https://github.com/foo/bar');
    expect(result).not.toBeNull();
    expect(result?.canonicalUrl).toBe('https://github.com/foo/bar');
  });

  it('returns null on invalid input instead of throwing', () => {
    expect(tryCanonicalizeRepoUrl('not a url')).toBeNull();
    expect(tryCanonicalizeRepoUrl('')).toBeNull();
  });
});

describe('isSimilarRepoUrl', () => {
  it('returns true for identical URLs', () => {
    expect(isSimilarRepoUrl(
      'https://github.com/foo/bar',
      'https://github.com/foo/bar',
    )).toBe(true);
  });

  it('returns true for SSH and HTTPS forms of the same repo', () => {
    expect(isSimilarRepoUrl(
      'git@github.com:foo/bar',
      'https://github.com/foo/bar.git',
    )).toBe(true);
  });

  it('returns true ignoring case differences on default hosts', () => {
    expect(isSimilarRepoUrl(
      'https://Github.com/Foo/Bar',
      'https://github.com/foo/bar',
    )).toBe(true);
  });

  it('returns false for different repos', () => {
    expect(isSimilarRepoUrl(
      'https://github.com/foo/bar',
      'https://github.com/foo/baz',
    )).toBe(false);
  });

  it('returns false when either input is invalid', () => {
    expect(isSimilarRepoUrl('not a url', 'https://github.com/foo/bar')).toBe(false);
    expect(isSimilarRepoUrl('https://github.com/foo/bar', '')).toBe(false);
    expect(isSimilarRepoUrl('not a url', 'also not a url')).toBe(false);
  });
});

describe('setRepoIdentityConfig / getRepoIdentityConfig', () => {
  // Reset config between tests to avoid cross-test leakage.
  beforeEach(() => {
    setRepoIdentityConfig({});
  });
  afterEach(() => {
    setRepoIdentityConfig({});
  });

  it('reading returns frozen object', () => {
    setRepoIdentityConfig({ caseSensitiveHosts: ['example.com'] });
    const config = getRepoIdentityConfig();
    expect(config.caseSensitiveHosts).toEqual(['example.com']);
    expect(() => {
      // @ts-expect-error — testing freeze
      config.caseSensitiveHosts = [];
    }).toThrow();
  });

  it('caseSensitiveHosts changes affect subsequent canonicalize calls', () => {
    // Default: case-insensitive
    expect(canonicalizeRepoUrl('https://Custom.Host.Net/Foo/Bar').owner).toBe('foo');

    // Opt the host into case-sensitive
    setRepoIdentityConfig({ caseSensitiveHosts: ['custom.host.net'] });
    expect(canonicalizeRepoUrl('https://Custom.Host.Net/Foo/Bar').owner).toBe('Foo');
  });

  it('default config has no caseSensitiveHosts', () => {
    expect(getRepoIdentityConfig().caseSensitiveHosts).toBeUndefined();
  });
});
