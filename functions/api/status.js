// GET /api/status -> { worker, ready, phase, pct, seen_ago_s }
// ¿Hay pestaña? ¿el modelo está cargado? ¿en qué fase va la carga?
import { getState, json } from './_queue.js';
import { checkAuth } from './_auth.js';
const STALE_MS = 70000;
export async function onRequestGet({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;
  const state = await getState();
  if (!state) return json({ worker: false, ready: false, note: 'ninguna pestaña reportó todavía' });
  const ageMs = Date.now() - (state.at || 0);
  const alive = ageMs < STALE_MS;
  return json({ worker: alive, ready: alive ? !!state.ready : false, phase: state.phase || '', pct: state.pct || 0, seen_ago_s: Math.round(ageMs / 1000) });
}
