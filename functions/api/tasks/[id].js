// GET /api/tasks/:id -> el estado de la tarea
//   { id, status: queued|running|done|error, progress?, seed?, steps?, width?,
//     height?, generationMs?, model?, error? }
import { checkAuth } from '../_auth.js';
import { getTask, json } from '../_queue.js';

export async function onRequestGet({ request, env, params }) {
  const denied = checkAuth(request, env);
  if (denied) return denied;
  const t = await getTask(params.id);
  if (!t) return json({ error: 'tarea inexistente o vencida' }, 404);
  // no devolver campos internos ruidosos
  const { op, args, ...pub } = t;
  return json(pub);
}
