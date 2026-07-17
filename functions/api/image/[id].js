// GET /api/tasks/:id/image -> el PNG (cuando la tarea está done)
//   200 image/png · 409 si todavía no está lista · 404 si no existe
import { checkAuth } from '../_auth.js';
import { getTask, takeBlob, json } from '../_queue.js';

export async function onRequestGet({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  const t = await getTask(params.id);
  if (!t) return json({ error: 'tarea inexistente o vencida' }, 404);
  if (t.status === 'error') return json({ error: t.error || 'la generación falló' }, 409);
  if (t.status !== 'done') return json({ error: 'todavía no está lista', status: t.status, progress: t.progress }, 409);

  // keep:true -> se puede volver a bajar; el TTL la limpia.
  const blob = await takeBlob(params.id, { keep: true });
  if (!blob) return json({ error: 'la tarea está done pero el PNG no está (¿venció?)' }, 410);
  return new Response(blob.body, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="${params.id}.png"`,
      'Cache-Control': 'no-store',
      'X-Seed': String(t.seed ?? ''),
      'X-Generation-Ms': String(t.generationMs ?? ''),
    },
  });
}
