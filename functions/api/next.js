// GET /api/next -> 200 { id, op, args } | 204
// Long-poll: la request queda abierta hasta que haya trabajo. Baja la cuota y,
// clave, avanza por eventos de red (Chrome no throttlea esos callbacks), así el
// worker sobrevive minimizado — un setInterval no.

import { getPending, clearPending, putState, json } from './_queue.js';
import { checkAuth } from './_auth.js';

const HOLD_MS = 25000;
const CHECK_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function onRequestGet({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  // La pestaña cuelga su estado acá: /api/status sale gratis.
  const q = new URL(request.url).searchParams;
  await putState({
    ready: q.get('ready') === '1',
    busy: q.get('busy') === '1',
    phase: q.get('phase') || '',
    pct: Number(q.get('pct')) || 0,
    at: Date.now(),
  });

  // peek=1: reportar y salir (durante la carga, que no reclama trabajo pero sí
  // tiene que seguir dando señales de vida, o /api/status lo daría por muerto a
  // mitad de una descarga de 15 min).
  if (q.get('peek') === '1') {
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }

  const deadline = Date.now() + HOLD_MS;
  while (Date.now() < deadline) {
    const job = await getPending();
    if (job) { await clearPending(); return json(job); }
    await sleep(CHECK_MS);
  }
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}
