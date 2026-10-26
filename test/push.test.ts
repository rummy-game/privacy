import { describe, expect, it } from 'vitest';
import { decodePush } from '../functions/_lib/codec';
import { handleApi } from '../functions/_lib/handler';
import { MemoryMailer } from '../functions/_lib/mailer';
import { MemoryPusher, pushText } from '../functions/_lib/push';
import { Service } from '../functions/_lib/service';
import { MemoryStore } from '../functions/_lib/store';
import { defaultRules } from '../functions/_lib/rules';

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup() {
  const clock = { now: 1_000_000 };
  const store = new MemoryStore();
  const pusher = new MemoryPusher();
  const service = new Service(store, () => clock.now, mulberry(9), new MemoryMailer(), null, pusher);
  return { clock, store, pusher, service };
}

const TOKEN_A = 'tokenAAAAAAAAAAAAAAAAAAAAAAAA:1';
const TOKEN_B = 'tokenBBBBBBBBBBBBBBBBBBBBBBBB:2';
const newGame = { seats: 2, rules: defaultRules(), fillLevel: 'BEGINNER' as const, limitSeconds: 3600 };

/** Zwei Konten, B tritt A per Code bei; beide haben ein Gerät registriert, wenn `push` gesetzt ist. */
async function twoPlayers(push = true) {
  const ctx = setup();
  const a = (await ctx.service.createAccount())!;
  const b = (await ctx.service.createAccount())!;
  if (push) {
    expect(await ctx.service.setPush(a.id, TOKEN_A, 'de')).toBe(true);
    expect(await ctx.service.setPush(b.id, TOKEN_B, 'en')).toBe(true);
  }
  const created = await ctx.service.createGame(a.id, newGame);
  const joined = await ctx.service.join(b.id, created.view!.code);
  expect(joined.error).toBeNull();
  await ctx.service.flush();
  return { ...ctx, a, b, game: created.view!.id };
}

describe('Benachrichtigungen', () => {
  it('der Spieler, der zu Beginn dran ist, wird benachrichtigt, der andere nicht', async () => {
    const { pusher, a, b, game, service } = await twoPlayers();
    const first = (await service.view(a.id, game)).view!;
    const starter = first.current === first.mySeat ? TOKEN_A : TOKEN_B;
    expect(pusher.sent.map((s) => s.token)).toEqual([starter]);
    expect(pusher.sent[0].message.data?.game).toBe(game);
    void b;
  });

  it('nach einem Zug wird der nächste Mensch benachrichtigt, in seiner Sprache', async () => {
    const { pusher, a, b, game, service } = await twoPlayers();
    pusher.sent.length = 0;
    const v = (await service.view(a.id, game)).view!;
    const [mover, other, otherToken, lang] = v.current === v.mySeat ? [a, b, TOKEN_B, 'en'] : [b, a, TOKEN_A, 'de'];
    const turn = (await service.view(mover.id, game)).view!.turn;
    expect((await service.move(mover.id, game, { turn, table: null })).error).toBeNull();
    await service.flush();
    expect(pusher.sent).toHaveLength(1);
    expect(pusher.sent[0].token).toBe(otherToken);
    expect(pusher.sent[0].message.title).toBe(pushText('turn', lang).title);
    void other;
  });

  it('ohne registriertes Gerät oder nach dem Abschalten kommt nichts an', async () => {
    const { pusher, a, b, game, service } = await twoPlayers(false);
    expect(pusher.sent).toHaveLength(0);
    await service.setPush(a.id, TOKEN_A, 'de');
    await service.setPush(b.id, TOKEN_B, 'de');
    await service.clearPush(a.id, TOKEN_A);
    await service.clearPush(b.id, TOKEN_B);
    const v = (await service.view(a.id, game)).view!;
    const mover = v.current === v.mySeat ? a : b;
    await service.move(mover.id, game, { turn: v.turn, table: null });
    await service.flush();
    expect(pusher.sent).toHaveLength(0);
  });

  it('abgelaufene Geräte werden gelöscht', async () => {
    const { pusher, store, a, b, game, service } = await twoPlayers();
    pusher.invalidTokens.add(TOKEN_A).add(TOKEN_B);
    const v = (await service.view(a.id, game)).view!;
    const mover = v.current === v.mySeat ? a : b;
    await service.move(mover.id, game, { turn: v.turn, table: null });
    await service.flush();
    const other = mover.id === a.id ? b : a;
    expect(await store.pushTokensOf(other.id)).toEqual([]);
  });

  it('Tokens werden geprüft, je Konto höchstens fünf, und beim Löschen des Kontos entfernt', async () => {
    const { store, service } = setup();
    const a = (await service.createAccount())!;
    expect(await service.setPush(a.id, 'kurz', 'de')).toBe(false);
    expect(await service.setPush(a.id, 'mit Leerzeichen und viel zu lang genug' + 'x'.repeat(10), 'de')).toBe(false);
    for (let i = 0; i < 7; i++) {
      await service.setPush(a.id, `token${i}`.padEnd(24, 'x'), 'de');
      (service as unknown as { clock: () => number }).clock = () => 2_000_000 + i;
    }
    expect((await store.pushTokensOf(a.id)).length).toBeLessThanOrEqual(5);
    await service.deleteAccount(a.id);
    expect(await store.pushTokensOf(a.id)).toEqual([]);
  });

  it('die HTTP-Schicht nimmt Token an und ab', async () => {
    const { service, store } = setup();
    const a = (await service.createAccount())!;
    const call = (method: string, path: string, body = '') =>
      handleApi(
        new Request(`https://x/api/${path}`, { method, body: method === 'GET' ? undefined : body, headers: { 'X-Account': a.id, 'X-Secret': a.secret } }),
        service,
      );
    expect((await call('POST', 'push', `token ${TOKEN_A}\nlang en\n`)).status).toBe(200);
    expect(await store.pushTokensOf(a.id)).toEqual([{ token: TOKEN_A, lang: 'en' }]);
    expect((await call('POST', 'push', 'lang en\n')).status).toBe(400);
    expect((await call('POST', 'push/off', `token ${TOKEN_A}\n`)).status).toBe(200);
    expect(await store.pushTokensOf(a.id)).toEqual([]);
    expect(decodePush('token abc\nlang xx')).toEqual({ token: 'abc', lang: 'de' });
  });
});

describe('Gemerkte Partner und Einladungen', () => {
  it('wer per Code beitritt, wird gegenseitig gemerkt', async () => {
    const { a, b, service } = await twoPlayers(false);
    expect((await service.partners(a.id)).map((p) => p.id)).toEqual([b.id]);
    expect((await service.partners(b.id)).map((p) => p.id)).toEqual([a.id]);
  });

  it('eine Einladung kommt als Benachrichtigung an und wird ohne Code angenommen', async () => {
    const { pusher, a, b, service } = await twoPlayers();
    pusher.sent.length = 0;
    const lobby = await service.createGame(a.id, newGame);
    const gameId = lobby.view!.id;
    expect((await service.invite(a.id, gameId, b.id)).error).toBeNull();
    await service.flush();
    expect(pusher.sent).toHaveLength(1);
    expect(pusher.sent[0].token).toBe(TOKEN_B);
    expect(pusher.sent[0].message.body).toContain((await service.partners(b.id))[0].name);

    const list = await service.invites(b.id);
    expect(list).toEqual([{ gameId, fromName: (await service.partners(b.id))[0].name, seats: 2 }]);
    const accepted = await service.acceptInvite(b.id, gameId);
    expect(accepted.error).toBeNull();
    expect(accepted.view!.status).toBe('RUNNING');
    expect(await service.invites(b.id)).toEqual([]);
  });

  it('Einladungen gehen nur an Partner, nur vom Ersteller und nur in offene Lobbys', async () => {
    const { a, b, service, store } = await twoPlayers(false);
    const c = (await service.createAccount())!;
    const lobby = (await service.createGame(a.id, newGame)).view!.id;
    expect((await service.invite(a.id, lobby, c.id)).error).toBe('forbidden');
    expect((await service.invite(b.id, lobby, a.id)).error).toBe('forbidden');
    await store.addPartners(a.id, c.id, 1);
    expect((await service.invite(a.id, lobby, c.id)).error).toBeNull();
    // Annehmen ohne Einladung geht nicht
    expect((await service.acceptInvite(b.id, lobby)).error).toBe('notfound');
    // Ist die Partie gestartet oder voll, verschwindet die Einladung
    await service.start(a.id, lobby);
    expect(await service.invites(c.id)).toEqual([]);
  });

  it('ablehnen, Partner entfernen und Konto löschen räumen auf', async () => {
    const { a, b, service } = await twoPlayers(false);
    const lobby = (await service.createGame(a.id, newGame)).view!.id;
    await service.invite(a.id, lobby, b.id);
    await service.declineInvite(b.id, lobby);
    expect(await service.invites(b.id)).toEqual([]);
    await service.removePartner(a.id, b.id);
    expect(await service.partners(a.id)).toEqual([]);
    expect(await service.partners(b.id)).toEqual([]);
    expect((await service.invite(a.id, lobby, b.id)).error).toBe('forbidden');
  });

  it('beim Löschen eines Kontos verschwindet es aus der Partnerliste der anderen', async () => {
    const { a, b, service } = await twoPlayers(false);
    await service.deleteAccount(b.id);
    expect(await service.partners(a.id)).toEqual([]);
  });
});
