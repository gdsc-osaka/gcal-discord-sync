export const SCHEDULED = 1 as const;
export const ACTIVE = 2 as const;
export const COMPLETED = 3 as const;
export const CANCELED = 4 as const;

export type EventStatus = typeof SCHEDULED | typeof ACTIVE | typeof COMPLETED | typeof CANCELED;

export interface MappingEntry {
  discordEventId: string;
  contentHash: string;
  status: EventStatus;
  startISO: string;
  endISO: string;
  /** ISO8601 of the next status change (= start for SCHEDULED, = end for ACTIVE), null when terminal. */
  nextTransitionAt: string | null;
}

export type Mapping = Record<string, MappingEntry>;

export interface Config {
  calendarId: string;
  guildId: string;
  botToken: string;
  defaultLocation: string;
  horizonDays: number;
  /** Origin of the Cloudflare Worker relay (e.g. https://gcal-discord-sync-relay.<sub>.workers.dev). */
  proxyUrl?: string;
  /** Shared secret to authenticate against the relay; sent as `X-Proxy-Secret`. */
  proxySecret?: string;
}

/** A calendar event normalized into the shape we send to Discord. */
export interface NormalizedEvent {
  /** Stable key — uses Calendar API's instance id (recurring events get unique ids per instance). */
  gcalEventId: string;
  name: string;
  description: string;
  location: string;
  /** Inclusive ISO8601 start. */
  startISO: string;
  /** Exclusive ISO8601 end. */
  endISO: string;
  contentHash: string;
}

export interface DiscordEventCreateBody {
  name: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
  entity_type: 3;
  channel_id: null;
  privacy_level: 2;
  entity_metadata: { location: string };
  description?: string;
}

export interface DiscordEventPatchBody {
  name?: string;
  scheduled_start_time?: string;
  scheduled_end_time?: string;
  entity_metadata?: { location: string };
  description?: string;
  status?: EventStatus;
}

export interface DiscordEventResponse {
  id: string;
  status: EventStatus;
  name: string;
}

/** Either a still-existing event or a cancelled marker, as returned by Calendar.Events.list with showDeleted=true. */
export type CalendarChange =
  | { kind: 'upsert'; event: NormalizedEvent }
  | { kind: 'cancel'; gcalEventId: string };

export interface SyncPlan {
  creates: NormalizedEvent[];
  updates: { entry: MappingEntry; event: NormalizedEvent }[];
  cancels: { gcalEventId: string; entry: MappingEntry }[];
}

export interface StatusAction {
  gcalEventId: string;
  entry: MappingEntry;
  target: EventStatus;
  /** New nextTransitionAt to write back. */
  nextTransitionAt: string | null;
}
