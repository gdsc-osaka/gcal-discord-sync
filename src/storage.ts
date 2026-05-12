import { Mapping } from './types';

const MAPPING_KEY = 'MAPPINGS';
const SYNC_TOKEN_KEY = 'SYNC_TOKEN';

export function loadMapping(): Mapping {
  const raw = PropertiesService.getScriptProperties().getProperty(MAPPING_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Mapping;
  } catch (e) {
    console.error('Failed to parse MAPPINGS, resetting to empty:', e);
    return {};
  }
}

export function saveMapping(mapping: Mapping): void {
  PropertiesService.getScriptProperties().setProperty(MAPPING_KEY, JSON.stringify(mapping));
}

export function loadSyncToken(): string | null {
  return PropertiesService.getScriptProperties().getProperty(SYNC_TOKEN_KEY);
}

export function saveSyncToken(token: string | null): void {
  const props = PropertiesService.getScriptProperties();
  if (token) props.setProperty(SYNC_TOKEN_KEY, token);
  else props.deleteProperty(SYNC_TOKEN_KEY);
}
