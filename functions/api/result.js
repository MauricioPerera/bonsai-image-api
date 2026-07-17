// POST /api/result — la pestaña reporta el avance de una tarea.
//   { id, status:"running", progress:"step 2/4 · 30s" }        durante la generación
//   { id, status:"done", value:{ seed, steps, ..., generationMs } }  al terminar (el PNG ya subió a /api/blob)
//   { id, status:"error", error:"..." }
// Autenticado: si no, cualquiera inyecta estados falsos.
import { patchTask, json } from './_queue.js';
import { checkAuth } from './_auth.js';

export async function onRequestPost({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;
  let p;
  try { p = await request.json(); } catch { return json({ error: 'el body debe ser JSON' }, 400); }
  if (!p?.id) return json({ error: "falta 'id'" }, 400);

  const fields = { status: p.status || 'running' };
  if (p.progress != null) fields.progress = String(p.progress);
  if (p.error != null) { fields.error = String(p.error); fields.status = 'error'; }
  if (p.value && typeof p.value === 'object') Object.assign(fields, p.value); // seed, generationMs, etc.
  await patchTask(p.id, fields);
  return json({ ok: true });
}
