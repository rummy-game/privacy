import { describe, expect, it } from 'vitest';
import { decodeMove, decodeNewGame, encodeReply, encodeView } from '../functions/_lib/codec';
import { handleApi } from '../functions/_lib/handler';
import { chooseMove } from '../functions/_lib/ai';
import { Service } from '../functions/_lib/service';
import { MemoryStore } from '../functions/_lib/store';
import { defaultRules, drawOrPass, newGame, playTurn, validateTurn } from '../functions/_lib/rules';

function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function setup(seed = 7) {
  const clock = { now: 1_000_000 };
  const store = new MemoryStore();
  const service = new Service(store, () => clock.now, mulberry(seed));
  return { clock, store, service };
}

const req = (seats = 2, limit = 3600, level: 'BEGINNER' | 'MEDIUM' = 'BEGINNER', rules = defaultRules()) => ({
  seats,
  rules,
  fillLevel: level,
  limitSeconds: limit,
});

async function twoPlayers(limit = 3600, rules = defaultRules()) {
  const ctx = setup();
  const a = (await ctx.service.createAccount())!;
  const b = (await ctx.service.createAccount())!;
  const created = await ctx.service.createGame(a.id, req(2, limit, 'BEGINNER', rules));
  const joined = await ctx.service.join(b.id, created.view!.code);
  expect(joined.error).toBeNull();
  expect(joined.view!.status).toBe('RUNNING');
  return { ...ctx, a, b, game: created.view!.id };
}

const viewOf = async (s: Service, who: string, game: string) => (await s.view(who, game)).view!;

/** Das Konto, das gerade am Zug ist. */
async function turnOwner<T extends { id: string }>(s: Service, a: T, b: T, game: string): Promise<[T, T]> {
  const v = await viewOf(s, a.id, game);
  return v.current === v.mySeat ? [a, b] : [b, a];
}

describe('Konten', () => {
  it('haben eindeutige Zufallsnamen und melden sich mit dem Schlüssel an', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    expect(a.name).toMatch(/^[A-Za-zÄÖÜäöüß]+-[A-Za-z]+-\d{3}$/);
    expect(a.name).not.toBe(b.name);
    expect(await service.authenticate(a.id, a.secret)).toBe(true);
    expect(await service.authenticate(a.id, b.secret)).toBe(false);
    expect(await service.authenticate('unbekannt', a.secret)).toBe(false);
  });
});

describe('Partien', () => {
  it('starten nach dem zweiten Beitritt, jeder hat die volle Ablage', async () => {
    const { service, a, b, game } = await twoPlayers();
    const va = await viewOf(service, a.id, game);
    const vb = await viewOf(service, b.id, game);
    expect(va.rack).toHaveLength(14);
    expect(vb.rack).toHaveLength(14);
    expect(va.mySeat).toBe(0);
    expect(vb.mySeat).toBe(1);
    expect(va.rack.filter((x) => vb.rack.includes(x))).toEqual([]);
    expect(va.poolSize).toBe(106 - 28);
  });

  it('zeigen nie fremde Plättchen oder den Vorrat', async () => {
    const { service, a, b, game } = await twoPlayers();
    const va = await viewOf(service, a.id, game);
    const vb = await viewOf(service, b.id, game);
    const text = encodeView(va);
    const idsInText = text
      .split('\n')
      .filter((l) => l.startsWith('rack ') || l.startsWith('table '))
      .flatMap((l) => l.replace(/^\w+ /, '').split(',').filter(Boolean).map(Number));
    expect(new Set(idsInText)).toEqual(new Set(va.rack));
    expect(idsInText.some((id) => vb.rack.includes(id))).toBe(false);
    expect(va.seats[1].tileCount).toBe(14);
    expect(text.split('\n').find((l) => l.startsWith('pool '))).toMatch(/^pool \d+$/);
  });

  it('Ziehen wechselt den Spieler; ein wiederholter Zug ändert nichts', async () => {
    const { service, a, b, game } = await twoPlayers();
    const [who, other] = await turnOwner(service, a, b, game);
    const v0 = await viewOf(service, who.id, game);
    const done = await service.move(who.id, game, { turn: v0.turn, table: null });
    expect(done.error).toBeNull();
    expect(done.view!.turn).toBe(v0.turn + 1);
    expect(done.view!.rack).toHaveLength(15);
    const again = await service.move(who.id, game, { turn: v0.turn, table: null });
    expect(again.error).toBe('conflict');
    expect((await viewOf(service, who.id, game)).rack).toHaveLength(15);
    const vo = await viewOf(service, other.id, game);
    expect(vo.current).toBe(vo.mySeat);
  });

  it('weisen Züge ab, wenn man nicht dran ist, bei fremden oder ungültigen Plättchen', async () => {
    const { service, a, b, game } = await twoPlayers();
    const [who, other] = await turnOwner(service, a, b, game);
    const v = await viewOf(service, who.id, game);
    const foreign = (await viewOf(service, other.id, game)).rack;
    expect((await service.move(other.id, game, { turn: v.turn, table: null })).error).toBe('notyourturn');
    expect((await service.move(who.id, game, { turn: v.turn, table: [foreign.slice(0, 3)] })).error).toBe('invalid');
    expect((await service.move(who.id, game, { turn: v.turn, table: [[9999, 9998, 9997]] })).error).toBe('invalid');
    expect((await viewOf(service, who.id, game)).turn).toBe(v.turn);
  });

  it('legen eine gültige Kombination aus der eigenen Ablage', async () => {
    for (let seed = 1; seed < 80; seed++) {
      const ctx = setup(seed);
      const a = (await ctx.service.createAccount())!;
      const b = (await ctx.service.createAccount())!;
      const created = await ctx.service.createGame(a.id, req(2, 3600, 'BEGINNER', { ...defaultRules(), initialMeldMin: 0 }));
      await ctx.service.join(b.id, created.view!.code);
      const game = created.view!.id;
      const [who] = await turnOwner(ctx.service, a, b, game);
      const v = await viewOf(ctx.service, who.id, game);
      const meld = findGroup(v.rack);
      if (!meld) continue;
      const r = await ctx.service.move(who.id, game, { turn: v.turn, table: [meld] });
      expect(r.error).toBeNull();
      expect(r.view!.rack).toHaveLength(v.rack.length - meld.length);
      expect(r.view!.table).toEqual([meld]);
      expect(r.view!.event.kind).toBe('placed');
      return;
    }
    throw new Error('keine passende Gruppe gefunden');
  });

  it('zu zweit wird bei abgelaufener Frist nur gezogen, der Computer übernimmt nie', async () => {
    const { service, clock, a, b, game } = await twoPlayers(60);
    const [slow, quick] = await turnOwner(service, a, b, game);
    clock.now += 61_000;
    expect((await viewOf(service, slow.id, game)).rack).toHaveLength(15);
    let v = await viewOf(service, quick.id, game);
    expect(v.current).toBe(v.mySeat);
    await service.move(quick.id, game, { turn: v.turn, table: null });
    clock.now += 61_000;
    expect((await viewOf(service, slow.id, game)).rack).toHaveLength(16);
    v = await viewOf(service, quick.id, game);
    await service.move(quick.id, game, { turn: v.turn, table: null });
    clock.now += 61_000;
    await service.move(quick.id, game, { turn: (await viewOf(service, quick.id, game)).turn, table: null }).catch(() => undefined);
    clock.now += 61_000;
    v = await viewOf(service, quick.id, game);
    expect(v.seats.some((s) => s.ai !== null)).toBe(false);
    expect((await service.view(slow.id, game)).error).toBeNull();
  });

  it('mit mehr als zwei Plätzen übernimmt nach drei Versäumnissen der Computer', async () => {
    const ctx = setup();
    const a = (await ctx.service.createAccount())!;
    const b = (await ctx.service.createAccount())!;
    const c = (await ctx.service.createAccount())!;
    const created = (await ctx.service.createGame(a.id, req(3, 60))).view!;
    await ctx.service.join(b.id, created.code);
    await ctx.service.join(c.id, created.code);
    // Alle verpassen die Frist immer wieder: reihum wird gezogen, nach drei Versäumnissen je Platz übernimmt der Computer
    for (let i = 0; i < 12; i++) {
      ctx.clock.now += 61_000;
      await ctx.service.view(a.id, created.id);
    }
    const v = (await ctx.service.view(a.id, created.id)).view;
    // Der Betrachter selbst wurde ebenfalls ersetzt oder die Partie läuft mit Computerplätzen weiter
    const seats = v ? v.seats : (await ctx.store.loadGame(created.id))!.game.slots;
    expect(seats.some((x: { ai: string | null }) => x.ai !== null)).toBe(true);
  });

  it('Aufgeben zu zweit beendet die Partie als aufgegeben, der andere gewinnt, kein Computer', async () => {
    const { service, a, b, game } = await twoPlayers();
    const seatA = (await viewOf(service, a.id, game)).mySeat;
    await service.resign(a.id, game);
    const vb = await viewOf(service, b.id, game);
    expect(vb.status).toBe('FINISHED');
    expect(vb.event).toMatchObject({ kind: 'resigned', player: seatA });
    expect(vb.result!.winner).toBe(vb.mySeat);
    expect(vb.seats.some((s) => s.ai !== null)).toBe(false);
    // Der Aufgebende sieht die beendete Partie weiter und kann sie später verlassen
    expect(await service.list(a.id)).toHaveLength(1);
    await service.resign(a.id, game);
    expect(await service.list(a.id)).toHaveLength(0);
  });

  it('Aufgeben mit drei Plätzen: der Computer übernimmt, die Partie läuft weiter', async () => {
    const ctx = setup();
    const a = (await ctx.service.createAccount())!;
    const b = (await ctx.service.createAccount())!;
    const created = (await ctx.service.createGame(a.id, req(3))).view!;
    await ctx.service.join(b.id, created.code);
    await ctx.service.start(a.id, created.id);
    await ctx.service.resign(a.id, created.id);
    const vb = (await ctx.service.view(b.id, created.id)).view!;
    expect(vb.status).toBe('RUNNING');
    expect(vb.seats.some((x) => x.ai !== null && x.name.endsWith('(KI)'))).toBe(true);
  });

  it('ohne Zugfrist gibt es nie eine Frist, nur nach 30 Tagen Ruhe wird die Partie gelöscht', async () => {
    const { service, clock, a, b, game, store } = await twoPlayers(0);
    clock.now += 200 * 24 * 3600 * 1000;
    expect((await viewOf(service, a.id, game)).deadlineAt).toBe(0);
    expect((await viewOf(service, a.id, game)).rack).toHaveLength(14);
    // eine Änderung setzt die Ruhe zurück
    const [who] = await turnOwner(service, a, b, game);
    const v = await viewOf(service, who.id, game);
    await service.move(who.id, game, { turn: v.turn, table: null });
    clock.now += 29 * 24 * 3600 * 1000;
    await service.maintenance();
    expect(await store.loadGame(game)).not.toBeNull();
    clock.now += 2 * 24 * 3600 * 1000;
    await service.maintenance();
    expect(await store.loadGame(game)).toBeNull();
  });

  it('Ersteller startet mit KI, andere nicht; Code ist groß/klein egal', async () => {
    const { service } = setup();
    const a = (await service.createAccount())!;
    const b = (await service.createAccount())!;
    const created = (await service.createGame(a.id, req(3, 3600, 'MEDIUM'))).view!;
    expect((await service.start(b.id, created.id)).error).toBe('forbidden');
    const started = await service.start(a.id, created.id);
    expect(started.view!.status).toBe('RUNNING');
    expect(started.view!.seats.filter((s) => s.ai !== null)).toHaveLength(2);
    const c = (await service.createGame(a.id, req())).view!;
    expect((await service.join(b.id, 'XXXXXX')).error).toBe('notfound');
    expect((await service.join(b.id, c.code.toLowerCase())).error).toBeNull();
  });

  it('Konto löschen entfernt es und gibt Partien auf: zu zweit endet die Partie als aufgegeben', async () => {
    const { service, a, b, game } = await twoPlayers();
    const seatA = (await viewOf(service, a.id, game)).mySeat;
    expect(await service.deleteAccount(a.id)).toBe(true);
    expect(await service.authenticate(a.id, a.secret)).toBe(false);
    const v = await viewOf(service, b.id, game);
    expect(v.status).toBe('FINISHED');
    expect(v.event).toMatchObject({ kind: 'resigned', player: seatA });
    expect(v.seats.some((s) => s.ai !== null)).toBe(false);
  });

  it('gleichzeitige Einreichungen derselben Partie führen höchstens einen Zug aus', async () => {
    const { service, a, b, game } = await twoPlayers();
    const [who] = await turnOwner(service, a, b, game);
    const v = await viewOf(service, who.id, game);
    const results = await Promise.all([1, 2, 3].map(() => service.move(who.id, game, { turn: v.turn, table: null })));
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect((await viewOf(service, who.id, game)).rack).toHaveLength(15);
  });

  it('eine ganze Partie gegen die KI läuft bis zum Ende', async () => {
    const { service } = setup(3);
    const a = (await service.createAccount())!;
    const g = (await service.createGame(a.id, req(2, 3600, 'BEGINNER', { ...defaultRules(), handSize: 7, initialMeldMin: 0 }))).view!;
    let v = (await service.start(a.id, g.id)).view!;
    let guard = 0;
    while (v.status === 'RUNNING' && guard++ < 500) {
      expect(v.current).toBe(v.mySeat);
      v = (await service.move(a.id, g.id, { turn: v.turn, table: null })).view!;
    }
    expect(v.status).toBe('FINISHED');
    expect(v.result).not.toBeNull();
  });
});

describe('KI', () => {
  it('liefert nur gültige Züge und spielt Partien', () => {
    const rng = mulberry(11);
    let played = 0;
    for (let game = 0; game < 6; game++) {
      let state = newGame(2, { ...defaultRules(), initialMeldMin: 30 }, rng);
      for (let t = 0; t < 400 && !state.finished; t++) {
        const level = t % 2 === 0 ? 'MEDIUM' : 'BEGINNER';
        const move = chooseMove(state, level, rng);
        if (move) {
          const p = state.players[state.current];
          expect(validateTurn(state.table, p.rack, move, p.hasMelded, state.rules).valid).toBe(true);
          const r = playTurn(state, move);
          if (!r.ok) throw new Error('KI-Zug abgelehnt');
          state = r.state;
          played++;
        } else {
          state = drawOrPass(state);
        }
      }
    }
    expect(played).toBeGreaterThan(20);
  });
});

describe('Format und HTTP', () => {
  it('Züge und neue Partien werden wie in Kotlin gelesen', () => {
    expect(decodeMove('turn 3\ntable 1,2,3\ntable 40,41,42\nend\n')).toEqual({ turn: 3, table: [[1, 2, 3], [40, 41, 42]] });
    expect(decodeMove('turn 4\ndraw\nend\n')).toEqual({ turn: 4, table: null });
    expect(decodeMove('turn x\nend\n')).toBeNull();
    expect(decodeMove('turn 1\ntable 1,a\nend\n')).toBeNull();
    expect(decodeNewGame('newgame 2 2 14 30 0 MEDIUM 86400\n')!.seats).toBe(2);
    expect(decodeNewGame('newgame 9 2 14 30 0 MEDIUM 86400')).toBeNull();
    expect(decodeNewGame('Unsinn')).toBeNull();
  });

  it('die Antwort beginnt mit ok und enthält die Sicht', async () => {
    const { service, a, game } = await twoPlayers();
    const text = encodeReply(await service.view(a.id, game));
    expect(text.startsWith('ok\nRUMMY-ONLINE 1\n')).toBe(true);
    expect(text.trimEnd().endsWith('end')).toBe(true);
  });

  it('der HTTP-Ablauf', async () => {
    const { service } = setup();
    const call = (method: string, path: string, body = '', who?: { id: string; secret: string }) =>
      handleApi(
        new Request(`https://x.test/api/${path}`, {
          method,
          body: method === 'GET' || method === 'DELETE' ? undefined : body,
          headers: who ? { 'X-Account': who.id, 'X-Secret': who.secret } : {},
        }),
        service,
      );
    const acc = (await service.createAccount())!; // anonyme Konten gibt es nur noch in Tests
    const a = { id: acc.id, secret: acc.secret };
    expect((await call('GET', 'games')).status).toBe(401);
    expect((await call('GET', 'games', '', { ...a, secret: 'falsch' })).status).toBe(401);
    const created = await (await call('POST', 'games', 'newgame 2 2 14 30 0 BEGINNER 3600\n', a)).text();
    expect(created.startsWith('ok\n')).toBe(true);
    const id = created.match(/^game (\S+) /m)![1];
    expect((await call('POST', `games/${id}/start`, '', a)).status).toBe(200);
    expect((await call('POST', 'games', 'Unsinn', a)).status).toBe(400);
    expect((await call('GET', 'nichts', '', a)).status).toBe(404);
    expect((await (await call('GET', 'games', '', a)).text()).startsWith('RUMMY-LIST 1')).toBe(true);
    expect((await call('DELETE', 'account', '', a)).status).toBe(200);
    expect((await call('GET', 'games', '', a)).status).toBe(401);
  });
});

/** Drei Plättchen gleicher Zahl in drei Farben (id = Satz*52 + Farbe*13 + Zahl-1). */
function findGroup(rack: number[]): number[] | null {
  for (let n = 1; n <= 13; n++) {
    const same = rack.filter((id) => id < 104 && (id % 13) + 1 === n);
    const perColor = same.filter((id, i) => same.findIndex((x) => Math.floor((x % 52) / 13) === Math.floor((id % 52) / 13)) === i);
    if (perColor.length >= 3) return perColor.slice(0, 3);
  }
  return null;
}
