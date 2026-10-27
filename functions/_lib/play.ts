// Prüfung von Google-Play-Abos über die Play Developer API (purchases.subscriptionsv2). Der Dienst kennt nur die
// Schnittstelle; produktiv läuft `GooglePlayVerifier` mit einem Dienstkonto-Schlüssel aus dem Secret
// `PLAY_SERVICE_ACCOUNT` (das Dienstkonto braucht in der Play Console Zugriff auf Finanzdaten/Bestellungen der App).

import { googleAccessToken } from './push';

export const PLAY_PACKAGE = 'rp.rummy';
/** Abo-Produkt in der Play Console; Monats- und Jahrespreis sind Basispläne dieses einen Produkts. */
export const PREMIUM_PRODUCT = 'rummy_premium';

export interface PlaySubscription {
  /** Abo gilt (bezahlt, auch in Kulanzzeit nach Kündigung bis zum Laufzeitende). */
  active: boolean;
  /** Ende der bezahlten Laufzeit in Epoch-Millisekunden. */
  expiresAt: number;
  /** Beim Kauf von der App mitgegebene Kennung (die Konto-Kennung), `''` wenn keine. */
  accountId: string;
  /** Produkte der Bestellung. */
  productIds: string[];
  /** Zustand der Bestellung (Play: SUBSCRIPTION_STATE_*), für Fehlersuche. */
  state: string;
}

export interface PlayVerifier {
  /** `null`, wenn der Token unbekannt ist oder Google nicht antwortet. */
  verify(purchaseToken: string): Promise<PlaySubscription | null>;
}

export class NoPlayVerifier implements PlayVerifier {
  async verify(): Promise<PlaySubscription | null> {
    return null;
  }
}

/** Antworten im Arbeitsspeicher, für Tests. */
export class MemoryPlayVerifier implements PlayVerifier {
  subscriptions = new Map<string, PlaySubscription>();
  async verify(purchaseToken: string): Promise<PlaySubscription | null> {
    return this.subscriptions.get(purchaseToken) ?? null;
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** Zustände, in denen Zugriff besteht: bezahlt, in Kulanz oder gekündigt bis Laufzeitende. */
const ACTIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

export class GooglePlayVerifier implements PlayVerifier {
  private account: ServiceAccount | null;

  constructor(serviceAccountJson: string, private clock: () => number = Date.now) {
    try {
      const a = JSON.parse(serviceAccountJson) as ServiceAccount;
      this.account = a.client_email && a.private_key ? a : null;
    } catch {
      this.account = null;
    }
  }

  async verify(purchaseToken: string): Promise<PlaySubscription | null> {
    const a = this.account;
    if (!a || !/^[A-Za-z0-9._-]{10,2000}$/.test(purchaseToken)) return null;
    try {
      const access = await googleAccessToken(a, 'https://www.googleapis.com/auth/androidpublisher', this.clock);
      if (!access) return null;
      const res = await fetch(
        `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PLAY_PACKAGE}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
        { headers: { Authorization: `Bearer ${access}` } },
      );
      if (!res.ok) {
        console.error(`play ${res.status} ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const j = (await res.json()) as {
        subscriptionState?: string;
        lineItems?: Array<{ productId?: string; expiryTime?: string }>;
        externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
      };
      const items = j.lineItems ?? [];
      const expiresAt = Math.max(0, ...items.map((i) => (i.expiryTime ? Date.parse(i.expiryTime) || 0 : 0)));
      const state = j.subscriptionState ?? '';
      return {
        active: ACTIVE_STATES.has(state) && expiresAt > this.clock(),
        expiresAt,
        accountId: j.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? '',
        productIds: items.map((i) => i.productId ?? ''),
        state,
      };
    } catch (e) {
      console.error(`play fetch failed: ${String(e).slice(0, 100)}`);
      return null;
    }
  }
}
