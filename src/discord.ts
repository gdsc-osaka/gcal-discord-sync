import {
  DiscordEventCreateBody,
  DiscordEventPatchBody,
  DiscordEventResponse,
  EventStatus,
} from './types';

const API_BASE = 'https://discord.com/api/v10';

// Discord requires this User-Agent format; otherwise Cloudflare in front of the
// API rejects the request with HTTP 403 + body { code: 40333, message: "internal
// network error" }. UrlFetchApp's default UA looks like a generic crawler and
// gets blocked. See https://docs.discord.com/developers/reference#user-agent
const USER_AGENT =
  'DiscordBot (https://github.com/gdsc-osaka/gcal-discord-sync, 0.1.0)';

export class DiscordClient {
  constructor(
    private readonly botToken: string,
    private readonly guildId: string,
  ) {}

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
    const url = API_BASE + path;
    const baseOptions: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
      method,
      contentType: 'application/json',
      headers: {
        Authorization: `Bot ${this.botToken}`,
        'User-Agent': USER_AGENT,
      },
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
