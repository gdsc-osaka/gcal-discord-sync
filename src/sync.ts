import {
  ACTIVE,
  CalendarChange,
  CANCELED,
  COMPLETED,
  EventStatus,
  Mapping,
  MappingEntry,
  NormalizedEvent,
  SCHEDULED,
  StatusAction,
  SyncPlan,
} from './types';

/** GAS allows at most 20 project triggers; we reserve 5 (2 resident + 3 buffer). */
export const MAX_PINPOINT_TRIGGERS = 15;
/** Window over which a pinpoint trigger is pre-scheduled by incrementalSync. */
export const PINPOINT_LOOKAHEAD_MS = 5 * 60 * 1000 + 30 * 1000;

function isTerminal(s: EventStatus): boolean {
  return s === COMPLETED || s === CANCELED;
}

/** Returns the status & nextTransitionAt an event should have, given the current wall clock. */
export function initialStateForEvent(
  event: NormalizedEvent,
  now: Date,
): { status: EventStatus; nextTransitionAt: string | null } {
  const start = new Date(event.startISO);
  const end = new Date(event.endISO);
  if (now < start) return { status: SCHEDULED, nextTransitionAt: event.startISO };
  if (now < end) return { status: ACTIVE, nextTransitionAt: event.endISO };
  return { status: COMPLETED, nextTransitionAt: null };
}

/**
 * Build a sync plan from incremental Calendar API changes.
 * `horizonMs` filters out events that start beyond the configured horizon.
 */
export function diffAndPlan(
  changes: CalendarChange[],
  mapping: Mapping,
  now: Date,
  horizonMs: number,
): SyncPlan {
  const plan: SyncPlan = { creates: [], updates: [], cancels: [] };
  const horizon = now.getTime() + horizonMs;
  for (const change of changes) {
    if (change.kind === 'cancel') {
      const entry = mapping[change.gcalEventId];
      if (entry) plan.cancels.push({ gcalEventId: change.gcalEventId, entry });
      continue;
    }
    const event = change.event;
    const endMs = new Date(event.endISO).getTime();
    const startMs = new Date(event.startISO).getTime();
    if (endMs <= now.getTime()) continue; // already over
    if (startMs > horizon) continue; // beyond horizon

    const existing = mapping[event.gcalEventId];
    if (!existing) {
      plan.creates.push(event);
    } else if (existing.contentHash !== event.contentHash) {
      plan.updates.push({ entry: existing, event });
    }
  }
  return plan;
}

/** Build a sync plan by comparing a full snapshot against the persisted mapping. */
export function diffFullScan(events: NormalizedEvent[], mapping: Mapping): SyncPlan {
  const plan: SyncPlan = { creates: [], updates: [], cancels: [] };
  const seen = new Set<string>();
  for (const event of events) {
    seen.add(event.gcalEventId);
    const existing = mapping[event.gcalEventId];
    if (!existing) plan.creates.push(event);
    else if (existing.contentHash !== event.contentHash) plan.updates.push({ entry: existing, event });
  }
  for (const [gcalEventId, entry] of Object.entries(mapping)) {
    if (!seen.has(gcalEventId)) plan.cancels.push({ gcalEventId, entry });
  }
  return plan;
}

/**
 * Compute status PATCHes that are due as of `now`. Handles the "missed window"
 * case by chaining SCHEDULED→ACTIVE and ACTIVE→COMPLETED in one pass.
 */
export function computeStatusActions(mapping: Mapping, now: Date): StatusAction[] {
  const actions: StatusAction[] = [];
  for (const [gcalEventId, entry] of Object.entries(mapping)) {
    if (isTerminal(entry.status)) continue;
    let status: EventStatus = entry.status;
    let nextTransitionAt: string | null = entry.nextTransitionAt;
    const start = new Date(entry.startISO);
    const end = new Date(entry.endISO);

    if (status === SCHEDULED && now >= start) {
      actions.push({ gcalEventId, entry, target: ACTIVE, nextTransitionAt: entry.endISO });
      status = ACTIVE;
      nextTransitionAt = entry.endISO;
    }
    if (status === ACTIVE && now >= end) {
      actions.push({ gcalEventId, entry, target: COMPLETED, nextTransitionAt: null });
      status = COMPLETED;
      nextTransitionAt = null;
    }
    void nextTransitionAt;
  }
  return actions;
}

/**
 * Pick up to `max` distinct timestamps in the next `lookaheadMs` window where a
 * status transition should fire. Used to install one-shot triggers.
 */
export function pickReschedulingTimes(
  mapping: Mapping,
  now: Date,
  lookaheadMs: number = PINPOINT_LOOKAHEAD_MS,
  max: number = MAX_PINPOINT_TRIGGERS,
): string[] {
  const horizon = now.getTime() + lookaheadMs;
  const unique = new Set<string>();
  for (const entry of Object.values(mapping)) {
    if (isTerminal(entry.status)) continue;
    if (!entry.nextTransitionAt) continue;
    const ms = new Date(entry.nextTransitionAt).getTime();
    if (ms <= now.getTime()) continue; // overdue — handled inline by computeStatusActions
    if (ms > horizon) continue;
    unique.add(entry.nextTransitionAt);
  }
  return [...unique].sort().slice(0, max);
}

/** Build a fresh MappingEntry for a newly created Discord event. */
export function buildMappingEntry(
  event: NormalizedEvent,
  discordEventId: string,
  status: EventStatus,
  nextTransitionAt: string | null,
): MappingEntry {
  return {
    discordEventId,
    contentHash: event.contentHash,
    status,
    startISO: event.startISO,
    endISO: event.endISO,
    nextTransitionAt,
  };
}

/** Merge an existing entry with a new event's content, recomputing nextTransitionAt if relevant. */
export function applyUpdate(entry: MappingEntry, event: NormalizedEvent, now: Date): MappingEntry {
  const merged: MappingEntry = {
    ...entry,
    contentHash: event.contentHash,
    startISO: event.startISO,
    endISO: event.endISO,
  };
  if (isTerminal(entry.status)) return merged;
  // Recompute nextTransitionAt based on current status & new times.
  const start = new Date(event.startISO);
  const end = new Date(event.endISO);
  if (entry.status === SCHEDULED) {
    merged.nextTransitionAt = now < start ? event.startISO : event.endISO;
  } else if (entry.status === ACTIVE) {
    merged.nextTransitionAt = now < end ? event.endISO : event.endISO; // still end
  }
  return merged;
}
