import { describe, expect, it } from 'vitest';
import { handleApi } from '../functions/_lib/handler';
import { MemoryMailer } from '../functions/_lib/mailer';
import { MemoryPusher } from '../functions/_lib/push';
import { defaultRules } from '../functions/_lib/rules';
import { FREE_WEEKLY_GAMES, Service, weekEnd, weekOf } from '../functions/_lib/service';
import { MemoryStore } from '../functions/_lib/store';

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const newGame = { seats: 2, rules: defaultRules(), fillLevel: 'BEGINNER' as const, limitSeconds: 0 };

// Montag, 5. Oktober 2026 00:00 UTC
const MONDAY = Date.UTC(2026, 9, 5);

function setup() {
  const clock = { now: MONDAY + 10 * 3600_000 };
  const store = new MemoryStore();
  const service = new Service(store, () => clock.now, mulberry(7), new MemoryMailer(), null, new MemoryPusher());
  return { clock, store, service };
}

/** Eine Partie zu zweit starten (A erstellt, B tritt bei). */
async function play(service: Service, a: string, b: string) {
  const g = await service.createGame(a, newGame);
  if (g.error) return g;
  return service.join(b, g.view!.code);
}

describe('Wochenkontingent', () => {
  it('die Woche läuft von Montag bis Sonntag (UTC)', () => {
    expect(weekOf(MONDAY)).toBe(weekOf(MONDAY + 6 * DAY + 86_399_000));
    expect(weekOf(MONDAY + 7 * DAY)).toBe(weekOf(MONDAY) + 1);
    expect(weekOf(MONDAY - 1)).toBe(weekOf(MONDAY) - 1);
    expect(weekEnd(weekOf(MONDAY))).toBe(MONDAY + 7 * DAY);
  });

  it('gestartete Partien zählen für alle Menschen, offene Lobbys nicht', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    await service.createGame(a.id, newGame);
    expect((await service.quota(a.id)).used).toBe(0);
    expect((await play(service, a.id, b.id)).error).toBeNull();
    expect((await service.quota(a.id)).used).toBe(1);
    expect((await service.quota(b.id)).used).toBe(1);
  });

  it('nach fünf Partien ist Schluss: Erstellen, Beitreten und Annehmen scheitern mit quota', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    const c = (await service.createAccount())!;
    for (let i = 0; i < FREE_WEEKLY_GAMES; i++) {
      expect((await play(service, a.id, b.id)).error).toBeNull();
      // Platz schaffen: die laufenden Partien zählen höchstens zehn
      for (const g of await service.list(a.id)) await service.resign(a.id, g.id);
    }
    expect((await service.quota(a.id)).used).toBe(FREE_WEEKLY_GAMES);
    expect((await service.createGame(a.id, newGame)).error).toBe('quota');
    const lobby = (await service.createGame(c.id, newGame)).view!;
    expect((await service.join(a.id, lobby.code)).error).toBe('quota');
    expect((await service.quota(c.id)).used).toBe(0);
  });

  it('ein erschöpfter Gastgeber blockiert den Beitritt anderer mit hostquota', async () => {
    const { service, store, clock } = setup();
    const host = (await service.createAccount())!;
    const guest = (await service.createAccount())!;
    const lobby = (await service.createGame(host.id, newGame)).view!;
    // Gastgeber verbraucht sein Kontingent anderweitig
    for (let i = 0; i < FREE_WEEKLY_GAMES; i++) await store.addUsage(host.id, weekOf(clock.now));
    expect((await service.join(guest.id, lobby.code)).error).toBe('hostquota');
    expect((await service.start(host.id, lobby.id)).error).toBe('quota');
  });

  it('der Zähler setzt sich in der neuen Woche zurück', async () => {
    const { service, store, clock } = setup();
    const a = (await service.createAccount())!;
    for (let i = 0; i < FREE_WEEKLY_GAMES; i++) await store.addUsage(a.id, weekOf(clock.now));
    expect((await service.createGame(a.id, newGame)).error).toBe('quota');
    clock.now = MONDAY + 7 * DAY + 60_000;
    expect((await service.createGame(a.id, newGame)).error).toBeNull();
    expect((await service.quota(a.id)).used).toBe(0);
  });

  it('Premium ist unbegrenzt und läuft ab', async () => {
    const { service, store, clock } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    for (let i = 0; i < FREE_WEEKLY_GAMES + 3; i++) await store.addUsage(a.id, weekOf(clock.now));
    expect(await service.grantPremium(a.id, clock.now + 30 * DAY, 'admin')).toBe(true);
    const q = await service.quota(a.id);
    expect(q.premium).toBe(true);
    expect(q.limit).toBe(0);
    expect((await play(service, a.id, b.id)).error).toBeNull();
    clock.now += 31 * DAY;
    expect((await service.quota(a.id)).premium).toBe(false);
    expect(await service.grantPremium('nope', clock.now + DAY, 'admin')).toBe(false);
  });

  it('Konto löschen entfernt Zähler und Berechtigung', async () => {
    const { service, store, clock } = setup();
    const a = (await service.createAccount())!;
    await store.addUsage(a.id, weekOf(clock.now));
    await service.grantPremium(a.id, clock.now + DAY, 'admin');
    await service.deleteAccount(a.id);
    expect(await store.usageOf(a.id, weekOf(clock.now))).toBe(0);
    expect(await store.premiumUntil(a.id)).toBe(0);
  });

  it('GET /api/quota liefert den Stand im Textformat', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const res = await handleApi(
      new Request('https://x.test/api/quota', { headers: { 'X-Account': a.id, 'X-Secret': a.secret } }),
      service,
    );
    expect(await res.text()).toBe(`RUMMY-QUOTA 1\nquota 0 ${FREE_WEEKLY_GAMES} 0 ${MONDAY + 7 * DAY}\nend\n`);
  });

  it('admin/premium braucht das Wartungs-Token', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const body = `account ${a.id}\ndays 30`;
    const bad = await handleApi(new Request('https://x.test/api/admin/premium', { method: 'POST', body }), service, 'tok');
    expect(bad.status).toBe(401);
    const ok = await handleApi(new Request('https://x.test/api/admin/premium', { method: 'POST', body, headers: { 'X-Maintenance': 'tok' } }), service, 'tok');
    expect(await ok.text()).toBe('ok\n');
    expect((await service.quota(a.id)).premium).toBe(true);
  });
});
