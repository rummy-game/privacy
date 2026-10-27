import { describe, expect, it } from 'vitest';
import { handleApi } from '../functions/_lib/handler';
import { MemoryMailer } from '../functions/_lib/mailer';
import { MemoryPusher } from '../functions/_lib/push';
import { defaultRules } from '../functions/_lib/rules';
import { MAX_REPORTS_PER_DAY, Service } from '../functions/_lib/service';
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

const newGame = { seats: 2, rules: defaultRules(), fillLevel: 'BEGINNER' as const, limitSeconds: 3600 };

function setup() {
  const clock = { now: 86_400_000 * 20 };
  const store = new MemoryStore();
  const mailer = new MemoryMailer();
  const service = new Service(store, () => clock.now, mulberry(4), mailer, null, new MemoryPusher());
  return { clock, store, mailer, service };
}

async function pair() {
  const ctx = setup();
  const a = (await ctx.service.createAccount())!;
  const b = (await ctx.service.createAccount())!;
  const created = await ctx.service.createGame(a.id, newGame);
  await ctx.service.join(b.id, created.view!.code);
  return { ...ctx, a, b, game: created.view!.id };
}

describe('Blockieren', () => {
  it('ein Block trennt die Partnerschaft und verhindert Einladung und Beitritt in beide Richtungen', async () => {
    const { a, b, service } = await pair();
    expect((await service.partners(a.id)).length).toBe(1);
    expect((await service.block(a.id, b.id)).error).toBeNull();
    expect(await service.partners(a.id)).toEqual([]);
    expect(await service.partners(b.id)).toEqual([]);
    expect((await service.blocks(a.id)).map((x) => x.id)).toEqual([b.id]);

    const lobby = (await service.createGame(a.id, newGame)).view!;
    expect((await service.join(b.id, lobby.code)).error).toBe('notfound');
    // Auch umgekehrt: B erstellt, A kann nicht beitreten
    const other = (await service.createGame(b.id, newGame)).view!;
    expect((await service.join(a.id, other.code)).error).toBe('notfound');
    // Einladungen gehen nicht mehr (die Partnerschaft ist weg)
    expect((await service.invite(a.id, lobby.id, b.id)).error).toBe('forbidden');
  });

  it('Aufheben erlaubt wieder den Beitritt; sich selbst oder Unbekannte blockieren geht nicht', async () => {
    const { a, b, service } = await pair();
    await service.block(a.id, b.id);
    expect((await service.block(a.id, a.id)).error).toBe('invalid');
    expect((await service.block(a.id, 'nope')).error).toBe('notfound');
    await service.unblock(a.id, b.id);
    const lobby = (await service.createGame(a.id, newGame)).view!;
    expect((await service.join(b.id, lobby.code)).error).toBeNull();
  });

  it('eine offene Einladung verschwindet beim Blockieren', async () => {
    const { a, b, service } = await pair();
    const lobby = (await service.createGame(a.id, newGame)).view!;
    await service.invite(a.id, lobby.id, b.id);
    expect((await service.invites(b.id)).length).toBe(1);
    await service.block(b.id, a.id);
    expect(await service.invites(b.id)).toEqual([]);
    expect((await service.acceptInvite(b.id, lobby.id)).error).toBe('notfound');
  });

  it('Blockieren per Sitz in der laufenden Partie', async () => {
    const { a, b, game, service } = await pair();
    const seatOfB = (await service.view(a.id, game)).view!.seats.findIndex((s) => !s.mine);
    expect((await service.blockSeat(a.id, game, seatOfB)).error).toBeNull();
    expect((await service.blocks(a.id)).map((x) => x.id)).toEqual([b.id]);
    expect((await service.blockSeat(a.id, game, seatOfB === 0 ? 1 : 0)).error).toBe('invalid');
    expect((await service.blockSeat(a.id, 'unbekannt', 0)).error).toBe('forbidden');
  });
});

describe('Melden und Sperren', () => {
  it('eine Meldung wird gespeichert und dem Betreiber gemailt; nur feste Gründe', async () => {
    const { a, b, game, service, mailer } = await pair();
    service.reportTo = 'ich@example.com';
    const seat = (await service.view(a.id, game)).view!.seats.findIndex((s) => !s.mine);
    expect((await service.report(a.id, game, seat, 'freitext hier')).error).toBe('invalid');
    expect((await service.report(a.id, game, seat, 'name')).error).toBeNull();
    await service.flush();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].to).toBe('ich@example.com');
    const reports = await service.adminReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ reportedId: b.id, reason: 'name', count: 1 });
  });

  it('höchstens 20 Meldungen je Konto und Tag', async () => {
    const { a, game, service, clock } = await pair();
    const seat = (await service.view(a.id, game)).view!.seats.findIndex((s) => !s.mine);
    for (let i = 0; i < MAX_REPORTS_PER_DAY; i++) expect((await service.report(a.id, game, seat, 'behavior')).error).toBeNull();
    expect((await service.report(a.id, game, seat, 'behavior')).error).toBe('throttled');
    clock.now += 25 * 3600 * 1000;
    expect((await service.report(a.id, game, seat, 'behavior')).error).toBeNull();
  });

  it('Sperren entfernt das Konto, hält die Adresse draußen und lässt sich aufheben', async () => {
    const { service, store, mailer } = setup();
    await service.startAuth('boese@example.com', 'login', 'de');
    const r = await service.verifyAuth('boese@example.com', mailer.lastCode()!, 'login');
    const id = r.account!.id;
    expect(await service.adminBan(id, 'name')).toBe(true);
    expect(await store.getAccount(id)).toBeNull();
    expect((await service.startAuth('Boese@Example.com', 'login', 'de')).error).toBe('banned');
    expect(await service.adminUnban('boese@example.com')).toBe(true);
    expect((await service.startAuth('boese@example.com', 'login', 'de')).error).toBeNull();
  });

  it('die HTTP-Schicht: Blocken, Melden und Betreiberzugang nur mit Token', async () => {
    const { a, b, game, service } = await pair();
    const seat = (await service.view(a.id, game)).view!.seats.findIndex((s) => !s.mine);
    const call = (method: string, path: string, body = '', headers: Record<string, string> = { 'X-Account': a.id, 'X-Secret': a.secret }) =>
      handleApi(new Request(`https://x/api/${path}`, { method, body: method === 'GET' ? undefined : body, headers }), service, 'geheim');
    expect(await (await call('POST', `games/${game}/report`, `seat ${seat}\nreason behavior\n`)).text()).toBe('ok\n');
    expect(await (await call('POST', `games/${game}/block`, `seat ${seat}\n`)).text()).toBe('ok\n');
    expect(await (await call('GET', 'blocks')).text()).toContain(`blocked ${b.id} `);
    expect(await (await call('DELETE', `blocks/${b.id}`)).text()).toBe('ok\n');
    expect((await call('GET', 'admin/reports', '', {})).status).toBe(401);
    const list = JSON.parse(await (await call('GET', 'admin/reports', '', { 'X-Maintenance': 'geheim' })).text());
    expect(list[0].reportedId).toBe(b.id);
    expect(await (await call('POST', 'admin/ban', `account ${b.id}\nreason abuse\n`, { 'X-Maintenance': 'geheim' })).text()).toBe('ok\n');
    expect(await (await call('POST', 'admin/dismiss', `report ${list[0].id}\n`, { 'X-Maintenance': 'geheim' })).text()).toBe('ok\n');
    expect(await service.adminReports()).toEqual([]);
  });
});

describe('Gesamtstand gegen einzelne Mitspieler', () => {
  async function finish(winnerSeat: number | null) {
    const { a, b, game, service, store } = await pair();
    const g = (await store.loadGame(game))!.game;
    g.state = { ...g.state!, finished: true, winner: winnerSeat };
    g.status = 'FINISHED';
    await (service as unknown as { recordFinish(g: unknown): Promise<void> }).recordFinish(g);
    return { a, b, g, service };
  }

  it('Sieg und Niederlage werden für beide Seiten gezählt', async () => {
    const { a, b, g, service } = await finish(0);
    const winnerId = g.slots[0].accountId === a.id ? a.id : b.id;
    const loserId = winnerId === a.id ? b.id : a.id;
    expect(await service.records(winnerId)).toEqual([{ opponentId: loserId, wins: 1, losses: 0, draws: 0 }]);
    expect(await service.records(loserId)).toEqual([{ opponentId: winnerId, wins: 0, losses: 1, draws: 0 }]);
  });

  it('ohne Sieger zählt Remis, und der Stand wächst mit jeder Partie', async () => {
    const { a, b, service } = await finish(null);
    expect(await service.records(a.id)).toEqual([{ opponentId: b.id, wins: 0, losses: 0, draws: 1 }]);
  });

  it('beim Löschen eines Kontos verschwindet der Stand', async () => {
    const { a, b, service } = await finish(1);
    await service.deleteAccount(b.id);
    expect(await service.records(a.id)).toEqual([]);
  });
});
