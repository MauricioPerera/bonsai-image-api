// POST /api/load -> 202
// Pide a la pestaña que cargue el modelo (~3.2 GB, ~15 min la primera vez).
// Devuelve al instante: la carga tarda minutos, sondeá GET /api/status.
import { getPending, putPending, json } from './_queue.js';
import { checkAuth } from './_auth.js';
export async function onRequestPost({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;
  if (await getPending()) return json({ error: 'busy — hay otra operación en curso' }, 429);
  const id = crypto.randomUUID();
  await putPending({ id, op: 'load' });
  return json({ ok: true, id, note: 'carga pedida — sondeá GET /api/status' }, 202);
}
