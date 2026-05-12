import {
  applyUpdate,
  buildMappingEntry,
  computeStatusActions,
  diffAndPlan,
  diffFullScan,
  initialStateForEvent,
  pickReschedulingTimes,
} from '../src/sync';
import {
  ACTIVE,
  CalendarChange,
  CANCELED,
  COMPLETED,
  Mapping,
  MappingEntry,
  NormalizedEvent,
  SCHEDULED,
} from '../src/types';

const NOW = new Date('2026-05-13T10:00:00Z');
const HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

function ev(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    gcalEventId: 'gcal-1',
    name: 'Test Event',
    description: 'desc',
    location: 'Online',
    startISO: '2026-05-13T11:00:00Z',
    endISO: '2026-05-13T12:00:00Z',
    contentHash: 'hash-A',
    ...overrides,
  };
}

function entry(overrides: Partial<MappingEntry> = {}): MappingEntry {
  return {
    discordEventId: 'disc-1',
    contentHash: 'hash-A',
    status: SCHEDULED,
    startISO: '2026-05-13T11:00:00Z',
    endISO: '2026-05-13T12:00:00Z',
    nextTransitionAt: '2026-05-13T11:00:00Z',
    ...overrides,
  };
}

describe('diffAndPlan', () => {
  it('treats an unknown upsert as a create', () => {
    const changes: CalendarChange[] = [{ kind: 'upsert', event: ev() }];
    const plan = diffAndPlan(changes, {}, NOW, HORIZON_MS);
    expect(plan.creates).toHaveLength(1);
    expect(plan.updates).toHaveLength(0);
    expect(plan.cancels).toHaveLength(0);
  });

  it('treats an upsert with same hash as no-op', () => {
    const mapping: Mapping = { 'gcal-1': entry() };
    const plan = diffAndPlan([{ kind: 'upsert', event: ev() }], mapping, NOW, HORIZON_MS);
    expect(plan.creates).toHaveLength(0);
    expect(plan.updates).toHaveLength(0);
  });

  it('treats an upsert with new hash as update', () => {
    const mapping: Mapping = { 'gcal-1': entry({ contentHash: 'hash-OLD' }) };
    const plan = diffAndPlan([{ kind: 'upsert', event: ev() }], mapping, NOW, HORIZON_MS);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].event.contentHash).toBe('hash-A');
  });

  it('cancels an event present in mapping', () => {
    const mapping: Mapping = { 'gcal-1': entry() };
    const plan = diffAndPlan([{ kind: 'cancel', gcalEventId: 'gcal-1' }], mapping, NOW, HORIZON_MS);
    expect(plan.cancels).toEqual([{ gcalEventId: 'gcal-1', entry: mapping['gcal-1'] }]);
  });

  it('ignores cancel for an unknown event', () => {
    const plan = diffAndPlan([{ kind: 'cancel', gcalEventId: 'ghost' }], {}, NOW, HORIZON_MS);
    expect(plan.cancels).toHaveLength(0);
  });

  it('skips events that already ended', () => {
    const past = ev({
      startISO: '2026-05-13T08:00:00Z',
      endISO: '2026-05-13T09:00:00Z',
    });
    const plan = diffAndPlan([{ kind: 'upsert', event: past }], {}, NOW, HORIZON_MS);
    expect(plan.creates).toHaveLength(0);
  });

  it('skips events beyond the horizon', () => {
    const far = ev({
      startISO: '2026-07-13T11:00:00Z',
      endISO: '2026-07-13T12:00:00Z',
    });
    const plan = diffAndPlan([{ kind: 'upsert', event: far }], {}, NOW, HORIZON_MS);
    expect(plan.creates).toHaveLength(0);
  });
});

describe('diffFullScan', () => {
  it('detects orphans in mapping as cancels', () => {
    const mapping: Mapping = {
      'gcal-A': entry({ discordEventId: 'disc-A' }),
      'gcal-B': entry({ discordEventId: 'disc-B', contentHash: 'hash-B' }),
    };
    const plan = diffFullScan([ev({ gcalEventId: 'gcal-A' })], mapping);
    expect(plan.cancels.map((c) => c.gcalEventId)).toEqual(['gcal-B']);
    expect(plan.creates).toHaveLength(0);
  });

  it('classifies new vs updated by contentHash', () => {
    const mapping: Mapping = { 'gcal-A': entry({ contentHash: 'OLD' }) };
    const events = [ev({ gcalEventId: 'gcal-A' }), ev({ gcalEventId: 'gcal-NEW' })];
    const plan = diffFullScan(events, mapping);
    expect(plan.creates.map((e) => e.gcalEventId)).toEqual(['gcal-NEW']);
    expect(plan.updates.map((u) => u.event.gcalEventId)).toEqual(['gcal-A']);
  });
});

describe('computeStatusActions', () => {
  it('returns nothing when nothing is due', () => {
    const mapping: Mapping = { 'gcal-1': entry() }; // start 11:00, now 10:00
    expect(computeStatusActions(mapping, NOW)).toEqual([]);
  });

  it('transitions SCHEDULED -> ACTIVE when start has passed', () => {
    const mapping: Mapping = {
      'gcal-1': entry({
        startISO: '2026-05-13T09:00:00Z',
        endISO: '2026-05-13T12:00:00Z',
        nextTransitionAt: '2026-05-13T09:00:00Z',
      }),
    };
    const actions = computeStatusActions(mapping, NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0].target).toBe(ACTIVE);
    expect(actions[0].nextTransitionAt).toBe('2026-05-13T12:00:00Z');
  });

  it('transitions ACTIVE -> COMPLETED when end has passed', () => {
    const mapping: Mapping = {
      'gcal-1': entry({
        status: ACTIVE,
        startISO: '2026-05-13T08:00:00Z',
        endISO: '2026-05-13T09:30:00Z',
        nextTransitionAt: '2026-05-13T09:30:00Z',
      }),
    };
    const actions = computeStatusActions(mapping, NOW);
    expect(actions).toHaveLength(1);
    expect(actions[0].target).toBe(COMPLETED);
    expect(actions[0].nextTransitionAt).toBeNull();
  });

  it('chains SCHEDULED -> ACTIVE -> COMPLETED for missed windows', () => {
    const mapping: Mapping = {
      'gcal-1': entry({
        startISO: '2026-05-13T08:00:00Z',
        endISO: '2026-05-13T09:00:00Z',
        nextTransitionAt: '2026-05-13T08:00:00Z',
      }),
    };
    const actions = computeStatusActions(mapping, NOW);
    expect(actions.map((a) => a.target)).toEqual([ACTIVE, COMPLETED]);
  });

  it('ignores terminal entries', () => {
    const mapping: Mapping = {
      a: entry({ status: COMPLETED, nextTransitionAt: null }),
      b: entry({ status: CANCELED, nextTransitionAt: null }),
    };
    expect(computeStatusActions(mapping, NOW)).toEqual([]);
  });
});

describe('pickReschedulingTimes', () => {
  it('returns sorted unique times within the lookahead window', () => {
    const mapping: Mapping = {
      a: entry({ nextTransitionAt: '2026-05-13T10:02:00Z' }),
      b: entry({ nextTransitionAt: '2026-05-13T10:04:00Z' }),
      c: entry({ nextTransitionAt: '2026-05-13T10:02:00Z' }), // duplicate
      far: entry({ nextTransitionAt: '2026-05-13T11:00:00Z' }), // beyond lookahead
      past: entry({ nextTransitionAt: '2026-05-13T09:00:00Z' }), // overdue
      done: entry({ status: COMPLETED, nextTransitionAt: null }),
    };
    const times = pickReschedulingTimes(mapping, NOW);
    expect(times).toEqual(['2026-05-13T10:02:00Z', '2026-05-13T10:04:00Z']);
  });

  it('caps results at the configured max', () => {
    const mapping: Mapping = {};
    for (let i = 0; i < 30; i++) {
      const t = new Date(NOW.getTime() + (i + 1) * 1000).toISOString();
      mapping['id-' + i] = entry({ nextTransitionAt: t });
    }
    const times = pickReschedulingTimes(mapping, NOW, 60_000, 5);
    expect(times).toHaveLength(5);
  });
});

describe('initialStateForEvent', () => {
  it('returns SCHEDULED when start is in the future', () => {
    expect(initialStateForEvent(ev(), NOW)).toEqual({
      status: SCHEDULED,
      nextTransitionAt: '2026-05-13T11:00:00Z',
    });
  });
  it('returns ACTIVE inside the event window', () => {
    const e = ev({ startISO: '2026-05-13T09:00:00Z', endISO: '2026-05-13T11:00:00Z' });
    expect(initialStateForEvent(e, NOW)).toEqual({
      status: ACTIVE,
      nextTransitionAt: '2026-05-13T11:00:00Z',
    });
  });
  it('returns COMPLETED when end has passed', () => {
    const e = ev({ startISO: '2026-05-13T08:00:00Z', endISO: '2026-05-13T09:00:00Z' });
    expect(initialStateForEvent(e, NOW)).toEqual({ status: COMPLETED, nextTransitionAt: null });
  });
});

describe('buildMappingEntry & applyUpdate', () => {
  it('builds an entry that carries content + state', () => {
    const e = ev();
    const entry = buildMappingEntry(e, 'disc-NEW', SCHEDULED, e.startISO);
    expect(entry).toEqual({
      discordEventId: 'disc-NEW',
      contentHash: 'hash-A',
      status: SCHEDULED,
      startISO: e.startISO,
      endISO: e.endISO,
      nextTransitionAt: e.startISO,
    });
  });
  it('recomputes nextTransitionAt when SCHEDULED is rescheduled', () => {
    const old = entry({ nextTransitionAt: '2026-05-13T11:00:00Z' });
    const moved = ev({ startISO: '2026-05-14T11:00:00Z', endISO: '2026-05-14T12:00:00Z' });
    const updated = applyUpdate(old, moved, NOW);
    expect(updated.nextTransitionAt).toBe('2026-05-14T11:00:00Z');
    expect(updated.startISO).toBe(moved.startISO);
  });
  it('keeps terminal entries unchanged on update', () => {
    const old = entry({ status: COMPLETED, nextTransitionAt: null });
    const moved = ev({ contentHash: 'hash-NEW' });
    const updated = applyUpdate(old, moved, NOW);
    expect(updated.status).toBe(COMPLETED);
    expect(updated.nextTransitionAt).toBeNull();
    expect(updated.contentHash).toBe('hash-NEW');
  });
});
