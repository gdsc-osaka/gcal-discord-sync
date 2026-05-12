import { Config } from './types';

const REQUIRED_KEYS = ['CALENDAR_ID', 'DISCORD_GUILD_ID', 'DISCORD_BOT_TOKEN'] as const;

export function readConfig(): Config {
  const props = PropertiesService.getScriptProperties();
  const missing: string[] = [];
  for (const k of REQUIRED_KEYS) {
    if (!props.getProperty(k)) missing.push(k);
  }
  if (missing.length > 0) {
    throw new Error(
      `Script Properties missing required keys: ${missing.join(', ')}. ` +
        `Set them in the Apps Script editor under Project Settings > Script Properties.`,
    );
  }
  const horizonRaw = props.getProperty('HORIZON_DAYS');
  const horizonDays = horizonRaw ? parseInt(horizonRaw, 10) : 30;
  if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 365) {
    throw new Error(`HORIZON_DAYS must be an integer in [1, 365], got: ${horizonRaw}`);
  }
  const proxyUrl = props.getProperty('PROXY_URL') || undefined;
  const proxySecret = props.getProperty('PROXY_SECRET') || undefined;
  return {
    calendarId: props.getProperty('CALENDAR_ID')!,
    guildId: props.getProperty('DISCORD_GUILD_ID')!,
    botToken: props.getProperty('DISCORD_BOT_TOKEN')!,
    defaultLocation: props.getProperty('DEFAULT_LOCATION') || 'Online',
    horizonDays,
    proxyUrl: proxyUrl ? proxyUrl.replace(/\/+$/, '') : undefined,
    proxySecret,
  };
}
