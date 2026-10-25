import { handleApi } from '../_lib/handler';
import { Service } from '../_lib/service';
import { D1Store } from '../_lib/store';
import { cryptoRng } from '../_lib/rules';

interface Env {
  DB: D1Database;
  /** Geheimnis für den täglichen Wartungsaufruf (in Cloudflare als Secret gesetzt). */
  MAINTENANCE_TOKEN?: string;
}

/** Alle Anfragen unter /api/* des Online-Mehrspielers (Cloudflare Pages Functions mit D1). */
export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const service = new Service(new D1Store(env.DB), Date.now, cryptoRng);
  try {
    return await handleApi(request, service, env.MAINTENANCE_TOKEN ?? '');
  } catch {
    return new Response('error internal\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
};
