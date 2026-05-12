import {
  DiscordEventCreateBody,
  DiscordEventPatchBody,
  DiscordEventResponse,
  EventStatus,
} from './types';

const DISCORD_ORIGIN = 'https://discord.com';

export interface DiscordClientOptions {
  /** Origin to send requests to. Defaults to https://discord.com when no proxy is configured. */
  proxyUrl?: string;
  /** Shared secret accompanying the proxy request as X-Proxy-Secret. */
  proxySecret?: string;
}

export class DiscordClient {
  private readonly apiBase: string;
  private readonly proxySecret?: string;

  constructor(
    private readonly botToken: string,
    private readonly guildId: string,
    options: DiscordClientOptions = {},
  ) {
    const origin = options.proxyUrl?.replace(/\/+$/, '') || DISCORD_ORIGIN;
    this.apiBase = `${origin}/api/v10`;
    this.proxySecret = options.proxySecret;
  }

  createEvent(body: DiscordEventCreateBody): DiscordEventResponse {
    return this.request<DiscordEventResponse>(
      'post',
      `/guilds/${this.guildId}/scheduled-events`,
      body,
    );
  }

  patchEvent(eventId: string, body: DiscordEventPatchBody): DiscordEventResponse {
    return this.request<DiscordEventResponse>(
      'patch',
      `/guilds/${this.guildId}/scheduled-events/${eventId}`,
      body,
    );
  }

  setStatus(eventId: string, status: EventStatus): DiscordEventResponse {
    return this.patchEvent(eventId, { status });
  }

  private request<T>(
    method: GoogleAppsScript.URL_Fetch.HttpMethod,
    path: string,
    body?: unknown,
  ): T {
    const url = this.apiBase + path;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.botToken}`,
    };
    if (this.proxySecret) headers['X-Proxy-Secret'] = this.proxySecret;

    const baseOptions: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
      method,
      contentType: 'application/json',
      headers,
      muteHttpExceptions: true,
      payload: body ? JSON.stringify(body) : undefined,
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      const res = UrlFetchApp.fetch(url, baseOptions);
      const code = res.getResponseCode();
      if (code >= 200 && code < 300) {
        const text = res.getContentText();
        return text ? (JSON.parse(text) as T) : ({} as T);
      }
      if (code === 429 && attempt === 0) {
        const retryAfterSec = this.parseRetryAfter(res);
        Utilities.sleep(Math.min(retryAfterSec * 1000, 30_000));
        continue;
      }
      throw new Error(
        `Discord API ${method.toUpperCase()} ${path} -> ${code}: ${res.getContentText()}`,
      );
    }
    throw new Error(`Discord API ${method.toUpperCase()} ${path}: exhausted retries`);
  }

  private parseRetryAfter(res: GoogleAppsScript.URL_Fetch.HTTPResponse): number {
    try {
      const body = JSON.parse(res.getContentText()) as { retry_after?: number };
      if (typeof body.retry_after === 'number') return body.retry_after;
    } catch {
      // ignore
    }
    const header = res.getHeaders() as Record<string, string>;
    const h = header['Retry-After'] ?? header['retry-after'];
    return h ? parseFloat(h) : 1;
  }
}
