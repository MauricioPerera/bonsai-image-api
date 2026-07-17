// POST /api/generate  { prompt, steps?, width?, height?, seed? }  -> 202 { id, status }
//
// NO espera. Crea una tarea, la encola para la pestaña, y devuelve el id al
// instante. El que llama sondea GET /api/tasks/:id hasta status:"done" y baja el
// PNG de GET /api/tasks/:id/image. Una imagen tarda ~51 s: sostener esa conexión
// a través del edge es frágil (fue justo lo que falló en la versión síncrona).
//
//   id=$(curl -s -X POST .../api/generate -H "Authorization: Bearer $S" \
//        -H 'Content-Type: application/json' -d '{"prompt":"a bonsai"}' | jq -r .id)
//   # sondear:   curl .../api/tasks/$id -H "Authorization: Bearer $S"
//   # cuando done: curl .../api/tasks/$id/image -H "Authorization: Bearer $S" -o out.png

import { checkAuth } from './_auth.js';
import { getPending, putPending, putTask, getState, json } from './_queue.js';

export async function onRequestPost({ request, env }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'el body debe ser JSON' }, 400); }
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return json({ error: "falta 'prompt'" }, 400);

  // Un engine, una GPU: una imagen a la vez. Si hay algo en cola o el worker está
  // ocupado, 429 — que reintente cuando la anterior termine.
  const st = await getState();
  if (await getPending()) return json({ error: 'busy — hay una imagen en cola' }, 429);
  if (st && st.busy) return json({ error: 'busy — el worker está generando' }, 429);

  const args = {
    prompt,
    steps: Number.isInteger(body?.steps) ? body.steps : undefined,
    width: Number.isInteger(body?.width) ? body.width : undefined,
    height: Number.isInteger(body?.height) ? body.height : undefined,
    seed: (typeof body?.seed === 'number' || typeof body?.seed === 'string') ? body.seed : undefined,
  };

  const id = crypto.randomUUID();
  await putTask({ id, op: 'generate', status: 'queued', args, prompt, createdAt: Date.now() });
  await putPending({ id, op: 'generate', args, blobId: id });

  return json({ id, status: 'queued', poll: `/api/tasks/${id}`, image: `/api/image/${id}` }, 202);
}
