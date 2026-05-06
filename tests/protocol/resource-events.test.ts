import { describe, it, expect } from 'vitest';
import {
  RESOURCE_MESH_EVENTS,
  compareMergeEvents,
  type ResourceMergedEvent,
} from '../../src/protocol/resource-events.js';

describe('RESOURCE_MESH_EVENTS', () => {
  it('exports the expected event names', () => {
    expect(RESOURCE_MESH_EVENTS.REDACTED).toBe('resource.redacted');
    expect(RESOURCE_MESH_EVENTS.ARCHIVED).toBe('resource.archived');
    expect(RESOURCE_MESH_EVENTS.MERGED).toBe('resource.merged');
  });

  it('is readonly at the type level', () => {
    // const-asserted; values are literal types. Compile-time check via tsc.
    const event: typeof RESOURCE_MESH_EVENTS.REDACTED = 'resource.redacted';
    expect(event).toBe('resource.redacted');
  });
});

describe('compareMergeEvents', () => {
  function event(overrides: Partial<ResourceMergedEvent> = {}): ResourceMergedEvent {
    return {
      resource_type: 'repo',
      source_canonical_url: 'https://github.com/foo/old',
      target_canonical_url: 'https://github.com/foo/new',
      merged_at: '2026-05-05T12:00:00Z',
      origin_hub_id: 'hub-a',
      ...overrides,
    };
  }

  it('returns 0 for identical events', () => {
    const a = event();
    const b = event();
    expect(compareMergeEvents(a, b)).toBe(0);
  });

  it('orders by origin_hub_id lexicographically (primary key)', () => {
    const a = event({ origin_hub_id: 'hub-a' });
    const b = event({ origin_hub_id: 'hub-b' });

    expect(compareMergeEvents(a, b)).toBe(-1);
    expect(compareMergeEvents(b, a)).toBe(1);
  });

  it('orders by merged_at when origin_hub_id is equal (secondary key)', () => {
    const earlier = event({ merged_at: '2026-05-05T11:00:00Z' });
    const later = event({ merged_at: '2026-05-05T13:00:00Z' });

    expect(compareMergeEvents(earlier, later)).toBe(-1);
    expect(compareMergeEvents(later, earlier)).toBe(1);
  });

  it('uses origin_hub_id ahead of merged_at (lexicographic precedence)', () => {
    // hub-a with later timestamp should still sort before hub-b with earlier timestamp.
    const aLate = event({ origin_hub_id: 'hub-a', merged_at: '2030-01-01T00:00:00Z' });
    const bEarly = event({ origin_hub_id: 'hub-b', merged_at: '2020-01-01T00:00:00Z' });

    expect(compareMergeEvents(aLate, bEarly)).toBe(-1);
  });

  it('is stable under Array.prototype.sort', () => {
    const events: ResourceMergedEvent[] = [
      event({ origin_hub_id: 'hub-c', merged_at: '2026-05-05T12:00:00Z' }),
      event({ origin_hub_id: 'hub-a', merged_at: '2026-05-05T15:00:00Z' }),
      event({ origin_hub_id: 'hub-b', merged_at: '2026-05-05T13:00:00Z' }),
      event({ origin_hub_id: 'hub-a', merged_at: '2026-05-05T12:00:00Z' }),
    ];

    const sorted = [...events].sort(compareMergeEvents);

    expect(sorted.map((e) => `${e.origin_hub_id}@${e.merged_at}`)).toEqual([
      'hub-a@2026-05-05T12:00:00Z',
      'hub-a@2026-05-05T15:00:00Z',
      'hub-b@2026-05-05T13:00:00Z',
      'hub-c@2026-05-05T12:00:00Z',
    ]);
  });

  it('is consistent — same inputs return same result across calls', () => {
    const a = event({ origin_hub_id: 'hub-x', merged_at: '2026-05-05T10:00:00Z' });
    const b = event({ origin_hub_id: 'hub-y', merged_at: '2026-05-05T11:00:00Z' });

    const r1 = compareMergeEvents(a, b);
    const r2 = compareMergeEvents(a, b);
    const r3 = compareMergeEvents(a, b);

    expect(r1).toBe(r2);
    expect(r2).toBe(r3);
  });

  it('comparator obeys transitivity: a<b and b<c implies a<c', () => {
    const a = event({ origin_hub_id: 'hub-a' });
    const b = event({ origin_hub_id: 'hub-b' });
    const c = event({ origin_hub_id: 'hub-c' });

    expect(compareMergeEvents(a, b)).toBe(-1);
    expect(compareMergeEvents(b, c)).toBe(-1);
    expect(compareMergeEvents(a, c)).toBe(-1);
  });
});
