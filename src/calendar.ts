import { CalendarChange, NormalizedEvent } from './types';

export class SyncTokenInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncTokenInvalidError';
  }
}

export type Hasher = (parts: string[]) => string;

/** Default hasher backed by GAS Utilities.computeDigest (SHA-1, hex). */
export const sha1Hasher: Hasher = (parts) => {
  const raw = parts.join('');
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    raw,
    Utilities.Charset.UTF_8,
  );
  return bytes
    .map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'))
    .join('');
};

const NAME_MAX = 100;
const DESCRIPTION_MAX = 1000;
const LOCATION_MAX = 100;

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function stripHtml(s: string): string {
  return s.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]+>/g, '');
}

interface RawTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** Resolve an all-day or timed event boundary into a concrete ISO8601 timestamp. */
function resolveBoundary(t: RawTime, fallbackTz: string): string {
  if (t.dateTime) return new Date(t.dateTime).toISOString();
  if (t.date) {
    // All-day events: Google represents end as exclusive next-day (e.g. start=2026-05-13, end=2026-05-14).
    // Treat the date as midnight in the calendar's local TZ.
    const [y, m, d] = t.date.split('-').map((v) => parseInt(v, 10));
    const utcMidnight = Date.UTC(y, m - 1, d, 0, 0, 0);
    const tz = t.timeZone || fallbackTz;
    const offsetMin = -getTimezoneOffsetMinutes(new Date(utcMidnight), tz);
    return new Date(utcMidnight - offsetMin * 60_000).toISOString();
  }
  throw new Error('Event has neither dateTime nor date');
}

/** Returns the offset in minutes that has to be added to UTC to get local time in `tz` at `date`. */
function getTimezoneOffsetMinutes(date: Date, tz: string): number {
  // Format the same instant in the target TZ and in UTC, compare the parsed dates.
  // In Apps Script, Utilities.formatDate is available, but we fall back to a portable approach.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const tzWall = Date.UTC(
    +get('year'),
    +get('month') - 1,
    +get('day'),
    +get('hour'),
    +get('minute'),
    +get('second'),
  );
  return Math.round((tzWall - date.getTime()) / 60_000);
}

export function normalizeEvent(
  raw: GoogleAppsScript.Calendar.Schema.Event,
  defaultLocation: string,
  defaultTz: string,
  hasher: Hasher,
): NormalizedEvent {
  if (!raw.id) throw new Error('Calendar event has no id');
  const name = clip((raw.summary || '(no title)').trim(), NAME_MAX);
  const description = clip(stripHtml(raw.description || ''), DESCRIPTION_MAX);
  const location = clip((raw.location || defaultLocation).trim() || defaultLocation, LOCATION_MAX);
  const startISO = resolveBoundary(raw.start as RawTime, defaultTz);
  const endISO = resolveBoundary(raw.end as RawTime, defaultTz);
  const contentHash = hasher([name, startISO, endISO, location, description]);
  return { gcalEventId: raw.id, name, description, location, startISO, endISO, contentHash };
}

/**
 * Fetch the events page-stream from the Advanced Calendar Service.
 * If `syncToken` is supplied, performs an incremental sync (no time range).
 * Throws SyncTokenInvalidError on 410 GONE.
 */
export function fetchIncremental(
  calendarId: string,
  syncToken: string,
  defaultLocation: string,
  defaultTz: string,
  hasher: Hasher,
): { changes: CalendarChange[]; nextSyncToken: string | null } {
  const changes: CalendarChange[] = [];
  let pageToken: string | undefined;
  let lastResponse: GoogleAppsScript.Calendar.Schema.Events | undefined;
  do {
    let res: GoogleAppsScript.Calendar.Schema.Events;
    try {
      res = Calendar.Events!.list(calendarId, {
        syncToken: pageToken ? undefined : syncToken,
        pageToken,
        showDeleted: true,
        singleEvents: true,
        maxResults: 250,
      });
    } catch (e) {
      if (isSyncTokenGone(e)) throw new SyncTokenInvalidError(String(e));
      throw e;
    }
    lastResponse = res;
    for (const item of res.items || []) {
      if (item.status === 'cancelled') {
        changes.push({ kind: 'cancel', gcalEventId: item.id! });
      } else if (item.start && item.end) {
        changes.push({
          kind: 'upsert',
          event: normalizeEvent(item, defaultLocation, defaultTz, hasher),
        });
      }
    }
    pageToken = res.nextPageToken || undefined;
  } while (pageToken);
  return { changes, nextSyncToken: lastResponse?.nextSyncToken ?? null };
}

/** Full scan within `now .. now + horizonDays`. Also returns the new sync token from the final page. */
export function fetchAllUpcoming(
  calendarId: string,
  horizonDays: number,
  defaultLocation: string,
  defaultTz: string,
  hasher: Hasher,
  now: Date = new Date(),
): { events: NormalizedEvent[]; nextSyncToken: string | null } {
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000).toISOString();
  const events: NormalizedEvent[] = [];
  let pageToken: string | undefined;
  let lastResponse: GoogleAppsScript.Calendar.Schema.Events | undefined;
  do {
    const res = Calendar.Events!.list(calendarId, {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      pageToken,
      maxResults: 250,
    });
    lastResponse = res;
    for (const item of res.items || []) {
      if (item.status === 'cancelled') continue;
      if (item.start && item.end) {
        events.push(normalizeEvent(item, defaultLocation, defaultTz, hasher));
      }
    }
    pageToken = res.nextPageToken || undefined;
  } while (pageToken);
  return { events, nextSyncToken: lastResponse?.nextSyncToken ?? null };
}

/** Re-prime a sync token by performing a no-op list. */
export function refreshSyncToken(calendarId: string, now: Date = new Date()): string | null {
  let pageToken: string | undefined;
  let lastResponse: GoogleAppsScript.Calendar.Schema.Events | undefined;
  do {
    const res = Calendar.Events!.list(calendarId, {
      timeMin: now.toISOString(),
      singleEvents: true,
      pageToken,
      maxResults: 250,
    });
    lastResponse = res;
    pageToken = res.nextPageToken || undefined;
  } while (pageToken);
  return lastResponse?.nextSyncToken ?? null;
}

function isSyncTokenGone(e: unknown): boolean {
  const msg = String(e);
  return /410|sync token|fullSyncRequired/i.test(msg);
}
