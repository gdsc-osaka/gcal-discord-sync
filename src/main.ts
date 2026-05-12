import {
  fetchAllUpcoming,
  fetchIncremental,
  refreshSyncToken,
  sha1Hasher,
  SyncTokenInvalidError,
} from './calendar';
import { readConfig } from './config';
import { DiscordClient } from './discord';
import { loadMapping, loadSyncToken, saveMapping, saveSyncToken } from './storage';
import {
  applyUpdate,
  buildMappingEntry,
  computeStatusActions,
  diffAndPlan,
  diffFullScan,
  initialStateForEvent,
  pickReschedulingTimes,
} from './sync';
import {
  CANCELED,
  Config,
  DiscordEventCreateBody,
  Mapping,
  NormalizedEvent,
  StatusAction,
  SyncPlan,
} from './types';

const TZ = Session.getScriptTimeZone() || 'Asia/Tokyo';

export function incrementalSync(): void {
  const config = readConfig();
  const discord = new DiscordClient(config.botToken, config.guildId, {
    proxyUrl: config.proxyUrl,
    proxySecret: config.proxySecret,
  });
  const syncToken = loadSyncToken();

  if (!syncToken) {
    console.info('No sync token present; seeding via fullReconcile.');
    fullReconcile();
    return;
  }

  const now = new Date();
  let mapping = loadMapping();
  let nextSyncToken: string | null = syncToken;

  try {
    const result = fetchIncremental(config.calendarId, syncToken, config.defaultLocation, TZ, sha1Hasher);
    const plan = diffAndPlan(result.changes, mapping, now, config.horizonDays * 86_400_000);
    mapping = applyPlan(plan, mapping, discord, config, now);
    nextSyncToken = result.nextSyncToken ?? syncToken;
  } catch (e) {
    if (e instanceof SyncTokenInvalidError) {
      console.warn('Sync token invalid; falling back to fullReconcile.');
      fullReconcile();
      return;
    }
    throw e;
  }

  mapping = applyStatusActions(computeStatusActions(mapping, now), mapping, discord);
  reschedulePinpointTriggers(mapping, now);
  saveMapping(mapping);
  saveSyncToken(nextSyncToken);
}

export function transitionOne(): void {
  const config = readConfig();
  const discord = new DiscordClient(config.botToken, config.guildId, {
    proxyUrl: config.proxyUrl,
    proxySecret: config.proxySecret,
  });
  const now = new Date();
  let mapping = loadMapping();
  const actions = computeStatusActions(mapping, now);
  if (actions.length === 0) {
    console.info('transitionOne fired but no actions are due.');
    return;
  }
  mapping = applyStatusActions(actions, mapping, discord);
  saveMapping(mapping);
}

export function fullReconcile(): void {
  const config = readConfig();
  const discord = new DiscordClient(config.botToken, config.guildId, {
    proxyUrl: config.proxyUrl,
    proxySecret: config.proxySecret,
  });
  const now = new Date();
  let mapping = loadMapping();

  const events = fetchAllUpcoming(
    config.calendarId,
    config.horizonDays,
    config.defaultLocation,
    TZ,
    sha1Hasher,
    now,
  );
  const plan = diffFullScan(events, mapping);
  mapping = applyPlan(plan, mapping, discord, config, now);
  mapping = applyStatusActions(computeStatusActions(mapping, now), mapping, discord);
  reschedulePinpointTriggers(mapping, now);
  saveMapping(mapping);

  // The reconcile list above uses timeMin/timeMax/orderBy and therefore
  // never returns nextSyncToken; obtain one via a separate unfiltered list.
  const nextSyncToken = refreshSyncToken(config.calendarId);
  if (nextSyncToken) {
    saveSyncToken(nextSyncToken);
  } else {
    console.warn(
      'refreshSyncToken returned no token; next incrementalSync will fall back to fullReconcile.',
    );
  }
}

export function installTriggers(): void {
  removeTriggersFor(['incrementalSync', 'fullReconcile', 'transitionOne']);
  ScriptApp.newTrigger('incrementalSync').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('fullReconcile').timeBased().atHour(3).everyDays(1).create();
  console.info('Resident triggers installed. Running initial fullReconcile to seed state.');
  fullReconcile();
}

export function uninstallTriggers(): void {
  removeTriggersFor(['incrementalSync', 'fullReconcile', 'transitionOne']);
  console.info('All triggers removed.');
}

// ----- helpers -----

function applyPlan(
  plan: SyncPlan,
  mapping: Mapping,
  discord: DiscordClient,
  config: Config,
  now: Date,
): Mapping {
  const next: Mapping = { ...mapping };

  for (const event of plan.creates) {
    try {
      const body = toCreateBody(event);
      const created = discord.createEvent(body);
      const state = initialStateForEvent(event, now);
      next[event.gcalEventId] = buildMappingEntry(
        event,
        created.id,
        state.status,
        state.nextTransitionAt,
      );
      console.info(`Created Discord event ${created.id} for ${event.gcalEventId} (${event.name}).`);
    } catch (e) {
      console.error(`Failed to create Discord event for ${event.gcalEventId}:`, e);
    }
  }

  for (const upd of plan.updates) {
    try {
      discord.patchEvent(upd.entry.discordEventId, {
        name: upd.event.name,
        scheduled_start_time: upd.event.startISO,
        scheduled_end_time: upd.event.endISO,
        entity_metadata: { location: upd.event.location },
        description: upd.event.description || undefined,
      });
      next[upd.event.gcalEventId] = applyUpdate(upd.entry, upd.event, now);
      console.info(`Patched Discord event ${upd.entry.discordEventId} (${upd.event.name}).`);
    } catch (e) {
      console.error(`Failed to patch Discord event ${upd.entry.discordEventId}:`, e);
    }
  }

  for (const cancel of plan.cancels) {
    try {
      // COMPLETED can't be patched; just drop from mapping.
      if (cancel.entry.status !== 3 && cancel.entry.status !== 4) {
        discord.setStatus(cancel.entry.discordEventId, CANCELED);
      }
      delete next[cancel.gcalEventId];
      console.info(`Canceled & dropped mapping for ${cancel.gcalEventId}.`);
    } catch (e) {
      console.error(`Failed to cancel Discord event ${cancel.entry.discordEventId}:`, e);
    }
  }

  void config;
  return next;
}

function applyStatusActions(
  actions: StatusAction[],
  mapping: Mapping,
  discord: DiscordClient,
): Mapping {
  if (actions.length === 0) return mapping;
  const next: Mapping = { ...mapping };
  for (const a of actions) {
    const current = next[a.gcalEventId];
    if (!current) continue;
    try {
      discord.setStatus(current.discordEventId, a.target);
      next[a.gcalEventId] = {
        ...current,
        status: a.target,
        nextTransitionAt: a.nextTransitionAt,
      };
      console.info(
        `Discord event ${current.discordEventId} -> status=${a.target} for ${a.gcalEventId}.`,
      );
    } catch (e) {
      console.error(`Failed status transition for ${a.gcalEventId} -> ${a.target}:`, e);
    }
  }
  return next;
}

function reschedulePinpointTriggers(mapping: Mapping, now: Date): void {
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === 'transitionOne') ScriptApp.deleteTrigger(t);
  }
  const times = pickReschedulingTimes(mapping, now);
  for (const iso of times) {
    ScriptApp.newTrigger('transitionOne').timeBased().at(new Date(iso)).create();
  }
  if (times.length > 0) {
    console.info(`Scheduled ${times.length} pinpoint trigger(s): ${times.join(', ')}`);
  }
}

function removeTriggersFor(handlerNames: string[]): void {
  const set = new Set(handlerNames);
  for (const t of ScriptApp.getProjectTriggers()) {
    if (set.has(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  }
}

function toCreateBody(event: NormalizedEvent): DiscordEventCreateBody {
  const body: DiscordEventCreateBody = {
    name: event.name,
    scheduled_start_time: event.startISO,
    scheduled_end_time: event.endISO,
    entity_type: 3,
    channel_id: null,
    privacy_level: 2,
    entity_metadata: { location: event.location },
  };
  if (event.description) body.description = event.description;
  return body;
}

// Entry-point exports above are detected by gas-webpack-plugin and re-emitted
// as top-level `function X(){}` stubs so the Apps Script editor lists them in
// the function picker. At bundle runtime, the IIFE re-binds each global to the
// real implementation, so trigger invocation calls into the bundled code.
