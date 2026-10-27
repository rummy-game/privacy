// Benachrichtigungen über Firebase Cloud Messaging (HTTP v1). Der Dienst kennt nur die Schnittstelle;
// produktiv läuft `FcmPusher` mit einem Dienstkonto-Schlüssel aus dem Secret `FCM_SERVICE_ACCOUNT`.

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/** `invalid`: das Gerät ist nicht mehr erreichbar (Token abgelaufen), der Token wird gelöscht. */
export type PushResult = 'ok' | 'invalid' | 'error';

export interface Pusher {
  send(token: string, message: PushMessage): Promise<PushResult>;
}

export class NoPusher implements Pusher {
  async send(): Promise<PushResult> {
    return 'error';
  }
}

/** Sammelt die Nachrichten im Arbeitsspeicher, für Tests. */
export class MemoryPusher implements Pusher {
  sent: Array<{ token: string; message: PushMessage }> = [];
  invalidTokens = new Set<string>();
  async send(token: string, message: PushMessage): Promise<PushResult> {
    if (this.invalidTokens.has(token)) return 'invalid';
    this.sent.push({ token, message });
    return 'ok';
  }
}

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlText = (text: string) => b64url(new TextEncoder().encode(text));

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

/** Zugriffstoken je Dienstkonto, bis kurz vor Ablauf wiederverwendet (gilt, solange die Worker-Instanz lebt). */
const tokenCache = new Map<string, { token: string; expires: number }>();

/** OAuth-Zugriffstoken eines Google-Dienstkontos für [scope] (JWT-Bearer-Verfahren), `null` bei Fehlern. */
export async function googleAccessToken(a: { client_email: string; private_key: string }, scope: string, clock: () => number = Date.now): Promise<string | null> {
  const cacheKey = `${a.client_email}|${scope}`;
  const cached = tokenCache.get(cacheKey);
  const now = clock();
  if (cached && cached.expires > now + 60_000) return cached.token;
  const iat = Math.floor(now / 1000);
  const claims = { iss: a.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 };
  const unsigned = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify(claims))}`;
  const der = Uint8Array.from(atob(a.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;
  tokenCache.set(cacheKey, { token: json.access_token, expires: now + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

export class FcmPusher implements Pusher {
  private account: ServiceAccount | null;

  constructor(serviceAccountJson: string, private clock: () => number = Date.now) {
    try {
      const a = JSON.parse(serviceAccountJson) as ServiceAccount;
      this.account = a.client_email && a.private_key && a.project_id ? a : null;
    } catch {
      this.account = null;
    }
  }

  private accessToken(a: ServiceAccount): Promise<string | null> {
    return googleAccessToken(a, 'https://www.googleapis.com/auth/firebase.messaging', this.clock);
  }

  async send(token: string, message: PushMessage): Promise<PushResult> {
    const a = this.account;
    if (!a) return 'error';
    try {
      const access = await this.accessToken(a);
      if (!access) return 'error';
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${a.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: { priority: 'HIGH', notification: { channel_id: 'turn' } },
          },
        }),
      });
      if (res.ok) return 'ok';
      if (res.status === 404 || res.status === 400) {
        const text = await res.text();
        if (/UNREGISTERED|INVALID_ARGUMENT|NOT_FOUND/.test(text)) return 'invalid';
      }
      return 'error';
    } catch {
      return 'error';
    }
  }
}

/** Texte der Benachrichtigungen; die Sprache stammt von der Einstellung der App beim Anmelden des Geräts. */
export function pushText(kind: 'turn' | 'invite', lang: string, name = ''): { title: string; body: string } {
  const en = lang === 'en';
  if (kind === 'turn') {
    return en
      ? { title: 'Your turn', body: 'A move is waiting for you in your Rummy game.' }
      : { title: 'Du bist dran', body: 'In deiner Rummy-Partie wartet ein Zug auf dich.' };
  }
  return en
    ? { title: 'Rummy invitation', body: `${name} invites you to a game.` }
    : { title: 'Einladung zu Rummy', body: `${name} lädt dich zu einer Partie ein.` };
}
