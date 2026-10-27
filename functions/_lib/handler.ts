// HTTP-Schicht über dem Dienst: dieselben Endpunkte wie der Kotlin-Server (`HttpApi.kt`).

import { decodeAuthStart, decodeAuthVerify, decodeMove, decodeNewGame, decodePush, decodeSeatAction, encodeAccount, encodeBlocks, encodeInvites, encodePartners, encodeQuota, encodeRecords, encodeReply, encodeSummaries } from './codec';
import type { OnlineReply } from './codec';
import type { Service } from './service';

const MAX_BODY = 4096;

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

const reply = (r: OnlineReply) => text(encodeReply(r));

/** Nur die eigene Adresse (und lokale Entwicklung) bedient die API; alte Deployment-Adressen und Vorschauen nicht. */
export function isAllowedHost(host: string, extra = ''): boolean {
  const allowed = ['rummy-game-6ke.pages.dev', 'localhost', '127.0.0.1', ...extra.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)];
  return allowed.includes(host.toLowerCase().replace(/:\d+$/, ''));
}

const tooMany = () => text('error ratelimit\n', 429);

export async function handleApi(request: Request, service: Service, maintenanceToken = ''): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const parts = path.split('/');
  const method = request.method;

  const raw = method === 'GET' || method === 'DELETE' ? '' : await request.text();
  if (raw.length > MAX_BODY) return text('error toolarge\n', 413);

  // Ratenbegrenzung der empfindlichen Aufrufe je Absenderadresse (Cloudflare nennt sie in CF-Connecting-IP).
  // Ohne Angabe (lokale Tests) entfällt sie; allgemeine Überflutung fängt die WAF-Regel von Cloudflare ab.
  const ip = request.headers.get('CF-Connecting-IP') ?? '';
  if (ip && method === 'POST' && path === 'auth/start') {
    const key = await service.limitKey(ip, 'start');
    // Das Tageslimit schützt das Mail-Kontingent, die Minutengrenze das Postfach Dritter.
    if (!(await service.allow(key, 5, 60_000)) || !(await service.allow(key, 15, 24 * 3600_000))) return tooMany();
  }
  if (ip && method === 'POST' && path === 'auth/verify') {
    if (!(await service.allow(await service.limitKey(ip, 'verify'), 10, 60_000))) return tooMany();
  }

  // Anmeldung und Registrierung nur per E-Mail-Code; anonyme Konten gibt es nicht mehr.
  if (method === 'POST' && path === 'auth/start') {
    const req = decodeAuthStart(raw);
    if (!req) return text('error invalid request\n', 400);
    const r = await service.startAuth(req.email, req.purpose, req.lang);
    return text(r.error ? `error ${r.error}\n` : 'ok\n');
  }
  if (method === 'POST' && path === 'auth/verify') {
    const req = decodeAuthVerify(raw);
    if (!req) return text('error invalid request\n', 400);
    const r = await service.verifyAuth(req.email, req.code, req.purpose);
    if (r.error) return text(`error ${r.error}\n`);
    return text(r.account ? encodeAccount(r.account) : 'ok\n');
  }
  if (method === 'POST' && path === 'account') return text('error gone\n', 410);

  if (parts[0] === 'admin') {
    const given = request.headers.get('X-Maintenance') ?? '';
    if (!maintenanceToken || given !== maintenanceToken) return text('error auth\n', 401);
    if (method === 'GET' && path === 'admin/reports') return text(JSON.stringify(await service.adminReports(), null, 1) + '\n');
    const field = (key: string) => new RegExp(`^${key} (.+)$`, 'm').exec(raw.replace(/\r/g, ''))?.[1]?.trim() ?? '';
    if (method === 'POST' && path === 'admin/ban') return text((await service.adminBan(field('account'), field('reason') || 'abuse')) ? 'ok\n' : 'error notfound\n');
    if (method === 'POST' && path === 'admin/unban') return text((await service.adminUnban(field('email'))) ? 'ok\n' : 'error invalid\n');
    if (method === 'POST' && path === 'admin/premium') {
      const days = Number(field('days'));
      if (!Number.isFinite(days) || days < 0 || days > 3660) return text('error invalid request\n', 400);
      return text((await service.grantPremiumDays(field('account'), days, 'admin')) ? 'ok\n' : 'error notfound\n');
    }
    if (method === 'POST' && path === 'admin/dismiss') {
      await service.adminDismiss(Number(field('report')));
      return text('ok\n');
    }
    return text('error notfound\n', 404);
  }

  if (method === 'POST' && path === 'maintenance') {
    const given = request.headers.get('X-Maintenance') ?? '';
    if (!maintenanceToken || given !== maintenanceToken) return text('error auth\n', 401);
    await service.maintenance();
    return text('ok\n');
  }

  const id = request.headers.get('X-Account') ?? '';
  const secret = request.headers.get('X-Secret') ?? '';
  if (!(await service.authenticate(id, secret))) return text('error auth\n', 401);

  // Raten von Codes und Namen erschweren: höchstens 10 Beitritte und 10 Namensänderungen pro Minute und Konto
  if (ip && method === 'POST' && (path === 'games/join' || path === 'account/name')) {
    if (!(await service.allow(`acct:${id}:${path}`, 10, 60_000))) return tooMany();
  }

  if (method === 'DELETE' && path === 'account') {
    await service.deleteAccount(id);
    return text('ok\n');
  }
  if (method === 'POST' && path === 'account/name' && raw.trim() !== '') {
    const m = /^name (.+)$/m.exec(raw.replace(/\r/g, ''));
    if (!m) return text('error invalid request\n', 400);
    const r = await service.setName(id, m[1]);
    return r.name ? text(`name ${r.name}\n`) : text(`error ${r.error}\n`, r.error === 'unknown' ? 404 : 200);
  }
  if (method === 'POST' && path === 'account/name') {
    const name = await service.rerollName(id);
    return name ? text(`name ${name}\n`) : text('error unknown\n', 404);
  }
  if (method === 'POST' && path === 'push') {
    const req = decodePush(raw);
    if (!req || !(await service.setPush(id, req.token, req.lang))) return text('error invalid request\n', 400);
    return text('ok\n');
  }
  if (method === 'POST' && path === 'push/off') {
    const req = decodePush(raw);
    if (!req) return text('error invalid request\n', 400);
    await service.clearPush(id, req.token);
    return text('ok\n');
  }
  if (method === 'GET' && path === 'blocks') return text(encodeBlocks(await service.blocks(id)));
  if (parts.length === 2 && parts[0] === 'blocks' && method === 'POST') {
    const r = await service.block(id, parts[1]);
    return text(r.error ? `error ${r.error}\n` : 'ok\n');
  }
  if (parts.length === 2 && parts[0] === 'blocks' && method === 'DELETE') {
    await service.unblock(id, parts[1]);
    return text('ok\n');
  }
  if (method === 'GET' && path === 'quota') return text(encodeQuota(await service.quota(id)));
  if (method === 'GET' && path === 'records') return text(encodeRecords(await service.records(id)));
  if (method === 'GET' && path === 'partners') return text(encodePartners(await service.partners(id)));
  if (method === 'DELETE' && parts.length === 2 && parts[0] === 'partners') {
    await service.removePartner(id, parts[1]);
    return text('ok\n');
  }
  if (method === 'GET' && path === 'invites') return text(encodeInvites(await service.invites(id)));
  if (method === 'POST' && parts.length === 3 && parts[0] === 'invites') {
    if (parts[2] === 'accept') return reply(await service.acceptInvite(id, parts[1]));
    if (parts[2] === 'decline') {
      await service.declineInvite(id, parts[1]);
      return text('ok\n');
    }
  }
  if (method === 'GET' && path === 'games') return text(encodeSummaries(await service.list(id)));
  if (method === 'POST' && path === 'games') {
    const req = decodeNewGame(raw);
    return req ? reply(await service.createGame(id, req)) : text('error invalid request\n', 400);
  }
  if (method === 'POST' && path === 'games/join') return reply(await service.join(id, raw.trim().slice(0, 16)));
  if (parts.length === 2 && parts[0] === 'games' && method === 'GET') return reply(await service.view(id, parts[1]));
  if (parts.length === 3 && parts[0] === 'games' && method === 'POST') {
    switch (parts[2]) {
      case 'start':
        return reply(await service.start(id, parts[1]));
      case 'resign':
        return reply(await service.resign(id, parts[1]));
      case 'presence': {
        const m = /^away (0|1)$/m.exec(raw.replace(/\r/g, ''));
        return m ? reply(await service.setAway(id, parts[1], m[1] === '1')) : text('error invalid request\n', 400);
      }
      case 'block':
      case 'report': {
        const act = decodeSeatAction(raw);
        if (!act) return text('error invalid request\n', 400);
        const r = parts[2] === 'block' ? await service.blockSeat(id, parts[1], act.seat) : await service.report(id, parts[1], act.seat, act.reason);
        return text(r.error ? `error ${r.error}\n` : 'ok\n');
      }
      case 'invite': {
        const r = await service.invite(id, parts[1], raw.trim().slice(0, 40));
        return text(r.error ? `error ${r.error}\n` : 'ok\n');
      }
      case 'turn': {
        const move = decodeMove(raw);
        return move ? reply(await service.move(id, parts[1], move)) : text('error invalid request\n', 400);
      }
    }
  }
  return text('error notfound\n', 404);
}
