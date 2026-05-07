import { describe, it, expect } from 'vitest';
import {
  RepoError,
  InvalidRepoUrlError,
  PolicyViolationError,
  CapabilityError,
  NotAttachedError,
} from '../../../src/kinds/repo/errors.js';

describe('RepoError hierarchy', () => {
  it('all concrete errors are instanceof RepoError', () => {
    const errors: RepoError[] = [
      new PolicyViolationError('hub', 'denied'),
      new CapabilityError(['workspace.list']),
      new NotAttachedError('https://github.com/foo/bar', '/tmp/bar'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(RepoError);
      expect(err).toBeInstanceOf(Error);
    }
  });

  it('all concrete errors expose a .code field', () => {
    expect(new PolicyViolationError('hub', 'd').code).toBe('policy_violation');
    expect(new CapabilityError(['x']).code).toBe('capability');
    expect(new NotAttachedError('u', '/p').code).toBe('not_attached');
  });
});

describe('InvalidRepoUrlError (re-exported from canonical-url)', () => {
  it('has code "invalid_url" and preserves input + reason', () => {
    const err = new InvalidRepoUrlError('not a url', 'malformed');
    expect(err.code).toBe('invalid_url');
    expect(err.input).toBe('not a url');
    expect(err.reason).toBe('malformed');
  });

  it('has a descriptive message', () => {
    const err = new InvalidRepoUrlError('not a url', 'malformed');
    expect(err.message).toContain('not a url');
    expect(err.message).toContain('malformed');
  });
});

describe('PolicyViolationError', () => {
  it('preserves layer and detail', () => {
    const err = new PolicyViolationError('swarm', 'allow_listed mismatch');
    expect(err.layer).toBe('swarm');
    expect(err.detail).toBe('allow_listed mismatch');
    expect(err.message).toContain('swarm');
    expect(err.message).toContain('allow_listed mismatch');
  });

  it('layer field accepts hub | repo | swarm | agent', () => {
    expect(new PolicyViolationError('hub', 'd').layer).toBe('hub');
    expect(new PolicyViolationError('repo', 'd').layer).toBe('repo');
    expect(new PolicyViolationError('swarm', 'd').layer).toBe('swarm');
    expect(new PolicyViolationError('agent', 'd').layer).toBe('agent');
  });
});

describe('CapabilityError', () => {
  it('preserves missing capabilities list', () => {
    const err = new CapabilityError(['workspace.list', 'workspace.declare']);
    expect(err.missing).toEqual(['workspace.list', 'workspace.declare']);
  });

  it('formats message with comma-separated missing list', () => {
    const err = new CapabilityError(['a.b', 'c.d']);
    expect(err.message).toContain('a.b');
    expect(err.message).toContain('c.d');
  });
});

describe('NotAttachedError', () => {
  it('preserves canonicalUrl and localPath', () => {
    const err = new NotAttachedError('https://github.com/foo/bar', '/tmp/bar');
    expect(err.canonicalUrl).toBe('https://github.com/foo/bar');
    expect(err.localPath).toBe('/tmp/bar');
  });

  it('message includes both fields', () => {
    const err = new NotAttachedError('https://github.com/foo/bar', '/tmp/bar');
    expect(err.message).toContain('/tmp/bar');
    expect(err.message).toContain('https://github.com/foo/bar');
  });
});
