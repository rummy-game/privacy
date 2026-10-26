// HTTP-Schicht über dem Dienst: dieselben Endpunkte wie der Kotlin-Server (`HttpApi.kt`).

import { decodeAuthStart, decodeAuthVerify, decodeMove, decodeNewGame, decodePush, decodeSeatAction, encodeAccount, encodeBlocks, encodeInvites, encodePartners, encodeReply, encodeSummaries } from './codec';
import type { OnlineReply } from './codec';
import type { Service } from './service';

const MAX_BODY = 4096;

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });

const reply = (r: OnlineReply) => text(encodeReply(r));

export async function handleApi(request: Request, service: Service, maintenanceToken = ''): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const parts = path.split('/');
  const method = request.method;

  const raw = method === 'GET' || method === 'DELETE' ? '' : await request.text();
  if (raw.length > MAX_BODY) return text('error toolarge\n', 413);

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
