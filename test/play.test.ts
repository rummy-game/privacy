import { describe, expect, it } from 'vitest';
import { handleApi } from '../functions/_lib/handler';
import { MemoryMailer } from '../functions/_lib/mailer';
import { MemoryPlayVerifier, PREMIUM_PRODUCT } from '../functions/_lib/play';
import { MemoryPusher } from '../functions/_lib/push';
import { cryptoRng } from '../functions/_lib/rules';
import { Service } from '../functions/_lib/service';
import { MemoryStore } from '../functions/_lib/store';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 27);

function setup() {
  const play = new MemoryPlayVerifier();
  const store = new MemoryStore();
  const service = new Service(store, () => NOW, cryptoRng, new MemoryMailer(), null, new MemoryPusher(), play);
  return { play, service };
}
const sub = (accountId: string, over = {}) => ({ active: true, expiresAt: NOW + 30 * DAY, accountId, productIds: [PREMIUM_PRODUCT], state: 'SUBSCRIPTION_STATE_ACTIVE', ...over });

describe('Play-Kauf einlösen', () => {
  it('gültiges Abo setzt Premium bis zum Laufzeitende', async () => {
    const { play, service } = setup();
    const a = (await service.createAccount())!;
    play.subscriptions.set('tok-aaaaaaaaaa', sub(a.id));
    expect(await service.redeemPlay(a.id, 'tok-aaaaaaaaaa')).toBe('ok');
    const q = await service.quota(a.id);
    expect(q.premium).toBe(true);
  });

  it('unbekannter Token, fremdes Konto, falsches Produkt, abgelaufen', async () => {
    const { play, service } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    expect(await service.redeemPlay(a.id, 'unbekannt-token')).toBe('unavailable');
    play.subscriptions.set('tok-bbbbbbbbbb', sub(b.id));
    expect(await service.redeemPlay(a.id, 'tok-bbbbbbbbbb')).toBe('foreign');
    play.subscriptions.set('tok-cccccccccc', sub(a.id, { productIds: ['anderes'] }));
    expect(await service.redeemPlay(a.id, 'tok-cccccccccc')).toBe('invalid');
    play.subscriptions.set('tok-dddddddddd', sub(a.id, { active: false, expiresAt: NOW - DAY, state: 'SUBSCRIPTION_STATE_EXPIRED' }));
    expect(await service.redeemPlay(a.id, 'tok-dddddddddd')).toBe('inactive');
    expect((await service.quota(a.id)).premium).toBe(false);
  });

  it('ein Token gehört nur einem Konto', async () => {
    const { play, service } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    play.subscriptions.set('tok-eeeeeeeeee', sub(a.id));
    expect(await service.redeemPlay(a.id, 'tok-eeeeeeeeee')).toBe('ok');
    // dieselbe Bestellung meldet Google nun mit Kennung von b (z. B. Konto gelöscht und neu angelegt)
    play.subscriptions.set('tok-eeeeeeeeee', sub(b.id));
    expect(await service.redeemPlay(b.id, 'tok-eeeeeeeeee')).toBe('foreign');
  });

  it('POST /api/premium/play', async () => {
    const { play, service } = setup();
    const a = (await service.createAccount())!;
    play.subscriptions.set('tok-ffffffffff', sub(a.id));
    const headers = { 'X-Account': a.id, 'X-Secret': a.secret };
    const bad = await handleApi(new Request('https://x.test/api/premium/play', { method: 'POST', body: 'nix', headers }), service);
    expect(bad.status).toBe(400);
    const ok = await handleApi(new Request('https://x.test/api/premium/play', { method: 'POST', body: 'token tok-ffffffffff', headers }), service);
    expect(await ok.text()).toBe('ok\n');
    const nope = await handleApi(new Request('https://x.test/api/premium/play', { method: 'POST', body: 'token tok-unbekannt-x', headers }), service);
    expect(await nope.text()).toBe('error unavailable\n');
  });
});
