import { describe, it, expect } from 'vitest';
import {
  effectiveVisibility,
  isVisibilityDowngrade,
  isVisibilityUpgrade,
  compareMergeEvents,
} from '../../../src/kinds/repo/policy.js';
import type { RepoVisibility } from '../../../src/protocol/repo.js';

const TIERS: RepoVisibility[] = ['private', 'hub_local', 'federated'];

describe('effectiveVisibility — full 3×3 matrix', () => {
  // Ordering: private (most restricted) > hub_local > federated (least restricted).
  // effectiveVisibility returns the more restricted of the two.

  it('private ∧ private = private', () => {
    expect(effectiveVisibility('private', 'private')).toBe('private');
  });

  it('private ∧ hub_local = private (more restricted wins)', () => {
    expect(effectiveVisibility('private', 'hub_local')).toBe('private');
    expect(effectiveVisibility('hub_local', 'private')).toBe('private');
  });

  it('private ∧ federated = private', () => {
    expect(effectiveVisibility('private', 'federated')).toBe('private');
    expect(effectiveVisibility('federated', 'private')).toBe('private');
  });

  it('hub_local ∧ hub_local = hub_local', () => {
    expect(effectiveVisibility('hub_local', 'hub_local')).toBe('hub_local');
  });

  it('hub_local ∧ federated = hub_local', () => {
    expect(effectiveVisibility('hub_local', 'federated')).toBe('hub_local');
    expect(effectiveVisibility('federated', 'hub_local')).toBe('hub_local');
  });

  it('federated ∧ federated = federated', () => {
    expect(effectiveVisibility('federated', 'federated')).toBe('federated');
  });

  it('is commutative across all 3×3 pairs', () => {
    for (const a of TIERS) {
      for (const b of TIERS) {
        expect(effectiveVisibility(a, b)).toBe(effectiveVisibility(b, a));
      }
    }
  });
});

describe('isVisibilityDowngrade', () => {
  it('returns true when going to a more restricted tier', () => {
    expect(isVisibilityDowngrade('federated', 'hub_local')).toBe(true);
    expect(isVisibilityDowngrade('federated', 'private')).toBe(true);
    expect(isVisibilityDowngrade('hub_local', 'private')).toBe(true);
  });

  it('returns false when going to a more open tier (that is an upgrade)', () => {
    expect(isVisibilityDowngrade('private', 'hub_local')).toBe(false);
    expect(isVisibilityDowngrade('hub_local', 'federated')).toBe(false);
    expect(isVisibilityDowngrade('private', 'federated')).toBe(false);
  });

  it('returns false for the no-change case', () => {
    for (const tier of TIERS) {
      expect(isVisibilityDowngrade(tier, tier)).toBe(false);
    }
  });
});

describe('isVisibilityUpgrade', () => {
  it('returns true when going to a more open tier', () => {
    expect(isVisibilityUpgrade('private', 'hub_local')).toBe(true);
    expect(isVisibilityUpgrade('hub_local', 'federated')).toBe(true);
    expect(isVisibilityUpgrade('private', 'federated')).toBe(true);
  });

  it('returns false when going to a more restricted tier (that is a downgrade)', () => {
    expect(isVisibilityUpgrade('federated', 'hub_local')).toBe(false);
    expect(isVisibilityUpgrade('hub_local', 'private')).toBe(false);
    expect(isVisibilityUpgrade('federated', 'private')).toBe(false);
  });

  it('returns false for the no-change case', () => {
    for (const tier of TIERS) {
      expect(isVisibilityUpgrade(tier, tier)).toBe(false);
    }
  });
});

describe('upgrade and downgrade are mutually exclusive and exhaustive (with no-op)', () => {
  it('exactly one of {downgrade, upgrade, no-op} holds for any (from, to) pair', () => {
    for (const from of TIERS) {
      for (const to of TIERS) {
        const down = isVisibilityDowngrade(from, to);
        const up = isVisibilityUpgrade(from, to);
        const noop = from === to;
        const flags = [down, up, noop].filter(Boolean);
        expect(flags).toHaveLength(1);
      }
    }
  });
});

describe('compareMergeEvents (re-exported from policy)', () => {
  it('is the same function as the one exported from resource-events', async () => {
    const { compareMergeEvents: fromResourceEvents } = await import(
      '../../../src/protocol/resource-events.js'
    );
    expect(compareMergeEvents).toBe(fromResourceEvents);
  });
});
