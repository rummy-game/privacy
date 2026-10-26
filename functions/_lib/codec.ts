// Textformat zwischen App und Server (Gegenstück zu `rummy.online.OnlineCodec` in Kotlin).

import type { AiLevel } from './ai';
import type { Rules, TileId } from './rules';

export type OnlineStatus = 'LOBBY' | 'RUNNING' | 'FINISHED';

export interface OnlineSeat {
  name: string;
  ai: AiLevel | null;
  open: boolean;
  mine: boolean;
  tileCount: number;
}

export interface OnlineEvent {
  kind: 'none' | 'started' | 'placed' | 'drew' | 'passed';
  player: number;
  count: number;
}

export interface OnlineResult {
  winner: number | null;
  scores: number[];
  remaining: number[];
}

export interface OnlineView {
  id: string;
  code: string;
  status: OnlineStatus;
  turn: number;
  mySeat: number;
  creator: boolean;
  current: number;
  rules: Rules;
  limitSeconds: number;
  deadlineAt: number;
  seats: OnlineSeat[];
  poolSize: number;
  table: TileId[][];
  rack: TileId[];
  hasMelded: boolean;
  newTileId: TileId | null;
  event: OnlineEvent;
  result: OnlineResult | null;
}

export interface OnlineSummary {
  id: string;
  code: string;
  status: OnlineStatus;
  myTurn: boolean;
  names: string[];
  deadlineAt: number;
}

export interface OnlineReply {
  error: string | null;
  detail: string;
  view: OnlineView | null;
}

export interface OnlineMove {
  turn: number;
  /** `null` = ziehen */
  table: TileId[][] | null;
}

export interface NewGameRequest {
  seats: number;
  rules: Rules;
  fillLevel: AiLevel;
  limitSeconds: number;
}

export type AuthPurpose = 'login' | 'delete';

export interface AuthStart {
  email: string;
  purpose: AuthPurpose;
  lang: 'de' | 'en';
}

export interface AuthVerify {
  email: string;
  code: string;
  purpose: AuthPurpose;
}

export const MIN_LIMIT_SECONDS = 30;
export const MAX_LIMIT_SECONDS = 7 * 24 * 3600;
export const DEFAULT_LIMIT_SECONDS = 24 * 3600;

const flag = (b: boolean) => (b ? 1 : 0);
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const ids = (v: number[]) => v.join(',');

export function encodeView(v: OnlineView): string {
  const lines: string[] = ['RUMMY-ONLINE 1'];
  lines.push(`game ${v.id} ${v.code}`);
  lines.push(`status ${v.status}`);
  lines.push(`turn ${v.turn}`);
  lines.push(`me ${v.mySeat} ${flag(v.creator)}`);
  lines.push(`current ${v.current}`);
  lines.push(`rules ${v.rules.jokers} ${v.rules.handSize} ${v.rules.initialMeldMin} ${flag(v.rules.randomStart)}`);
  lines.push(`limit ${v.limitSeconds} ${v.deadlineAt}`);
  for (const s of v.seats) lines.push(`seat ${s.ai ?? 'HUMAN'} ${flag(s.open)} ${flag(s.mine)} ${s.tileCount} ${clean(s.name)}`);
  lines.push(`pool ${v.poolSize}`);
  for (const m of v.table) lines.push(`table ${ids(m)}`);
  lines.push(`rack ${ids(v.rack)}`);
  lines.push(`melded ${flag(v.hasMelded)}`);
  if (v.newTileId !== null) lines.push(`drawn ${v.newTileId}`);
  lines.push(`event ${v.event.kind} ${v.event.player} ${v.event.count}`);
  if (v.result) lines.push(`result ${v.result.winner ?? -1} ${ids(v.result.scores)} ${ids(v.result.remaining)}`);
  lines.push('end');
  return lines.join('\n') + '\n';
}

export function encodeReply(r: OnlineReply): string {
  const head = r.error === null ? 'ok\n' : `error ${r.error} ${clean(r.detail)}\n`;
  return head + (r.view ? encodeView(r.view) : '');
}

export function encodeSummaries(list: OnlineSummary[]): string {
  const lines = ['RUMMY-LIST 1'];
  for (const g of list) {
    const names = g.names.map((n) => clean(n).replace(/\|/g, ' ')).join('|');
    lines.push(`game ${g.id} ${g.code} ${g.status} ${flag(g.myTurn)} ${g.deadlineAt} ${names}`);
  }
  lines.push('end');
  return lines.join('\n') + '\n';
}

/** `partner <id> <name>` je Zeile. */
export function encodePartners(list: Array<{ id: string; name: string }>): string {
  return ['RUMMY-PARTNERS 1', ...list.map((p) => `partner ${p.id} ${clean(p.name)}`), 'end'].join('\n') + '\n';
}

/** `invite <Partie> <Plätze> <Name>` je Zeile. */
export function encodeInvites(list: Array<{ gameId: string; fromName: string; seats: number }>): string {
  return ['RUMMY-INVITES 1', ...list.map((i) => `invite ${i.gameId} ${i.seats} ${clean(i.fromName)}`), 'end'].join('\n') + '\n';
}

/** `token <Gerätetoken>`, `lang de|en` (Zeilen in beliebiger Reihenfolge, ohne `end`). */
export function decodePush(text: string): { token: string; lang: string } | null {
  let token = '';
  let lang = 'de';
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1).trim();
    if (key === 'token') token = value;
    else if (key === 'lang') lang = value === 'en' ? 'en' : 'de';
    else return null;
  }
  return token ? { token, lang } : null;
}

export const encodeAccount = (a: { id: string; secret: string; name: string }) => `account ${a.id} ${a.secret} ${clean(a.name)}\n`;

function parseIds(text: string): number[] | null {
  if (text.trim() === '') return [];
  const out: number[] = [];
  for (const p of text.split(',')) {
    const t = p.trim();
    if (!/^\d{1,4}$/.test(t)) return null;
    out.push(Number(t));
  }
  return out;
}

/** Zug einreichen; fehlerhafte Eingaben ergeben `null`. */
export function decodeMove(text: string): OnlineMove | null {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (lines.length < 2 || lines[lines.length - 1] !== 'end') return null;
  let turn = -1;
  let draw = false;
  const table: TileId[][] = [];
  for (const line of lines.slice(0, -1)) {
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'turn') {
      if (!/^\d{1,9}$/.test(rest)) return null;
      turn = Number(rest);
    } else if (key === 'draw') draw = true;
    else if (key === 'table') {
      const m = parseIds(rest);
      if (!m) return null;
      table.push(m);
    } else return null;
  }
  if (turn < 0 || (draw && table.length > 0) || (!draw && table.length === 0)) return null;
  return { turn, table: draw ? null : table };
}

/** `newgame <Plätze> <Joker> <Startplättchen> <Mindestpunkte> <Zufallsstart> <KI-Stufe> <Frist>` */
export function decodeNewGame(text: string): NewGameRequest | null {
  const p = text.trim().split(' ');
  if (p.length !== 8 || p[0] !== 'newgame') return null;
  const n = p.slice(1, 6).map(Number);
  const limit = Number(p[7]);
  if (n.some((x) => !Number.isInteger(x)) || !Number.isInteger(limit)) return null;
  const level = p[6] as AiLevel;
  if (!['BEGINNER', 'MEDIUM', 'HARD', 'EXPERT'].includes(level)) return null;
  const [seats, jokers, handSize, initialMeldMin, randomStart] = n;
  if (seats < 2 || seats > 4 || limit < MIN_LIMIT_SECONDS || limit > MAX_LIMIT_SECONDS) return null;
  return { seats, rules: { jokers, handSize, initialMeldMin, randomStart: randomStart === 1 }, fillLevel: level, limitSeconds: limit };
}

function keyValues(text: string): Map<string, string> | null {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  if (lines.length < 2 || lines[lines.length - 1] !== 'end') return null;
  const map = new Map<string, string>();
  for (const line of lines.slice(0, -1)) {
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    map.set(line.slice(0, sp), line.slice(sp + 1).trim());
  }
  return map;
}

/** `email <adresse>`, `purpose login|delete`, `lang de|en`, `end` */
export function decodeAuthStart(text: string): AuthStart | null {
  const m = keyValues(text);
  const email = m?.get('email');
  const purpose = m?.get('purpose') ?? 'login';
  const lang = m?.get('lang') ?? 'de';
  if (!email || (purpose !== 'login' && purpose !== 'delete') || (lang !== 'de' && lang !== 'en')) return null;
  return { email, purpose, lang };
}

/** `email <adresse>`, `code <sechs Ziffern>`, `purpose login|delete`, `end` */
export function decodeAuthVerify(text: string): AuthVerify | null {
  const m = keyValues(text);
  const email = m?.get('email');
  const code = m?.get('code');
  const purpose = m?.get('purpose') ?? 'login';
  if (!email || !code || !/^\d{6}$/.test(code) || (purpose !== 'login' && purpose !== 'delete')) return null;
  return { email, code, purpose };
}
