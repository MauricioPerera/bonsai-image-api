# bonsai-image-api

An HTTP API in front of the **Bonsai Image** WebGPU diffusion model — the same
browser-worker + Cloudflare Pages Functions pattern as Bonsai (LLM) and rag-local,
but **task-based** because a diffusion image takes ~30–50 s.

The model runs entirely in a browser tab (WebGPU, ~3.2 GB, `prism-ml/bonsai-image-*`).
The tab is the worker; the API relays requests to it. Nothing here reimplements
the model — the tab drives the real app's DOM and reads results from its
IndexedDB.

Live proof of concept: `bonsai-image.pages.dev` (a redeploy of the upstream HF
Space `webml-community/bonsai-image-webgpu` with `worker.js` injected + these
Functions). The Space itself is **not** mine; nothing was pushed to it.

## The API (task-based)

```sh
# 1) start a job — returns immediately
id=$(curl -s -X POST https://<proj>.pages.dev/api/generate \
  -H "Authorization: Bearer $API_SECRET" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red maple bonsai on a stone table"}' | jq -r .id)

# 2) poll — status goes queued -> running (with step progress) -> done
curl https://<proj>.pages.dev/api/tasks/$id -H "Authorization: Bearer $API_SECRET"
# {"status":"running","progress":"step 3/4 · 24.0s"}
# {"status":"done","seed":987556447,"generationMs":32943,...}

# 3) download the PNG when done
curl https://<proj>.pages.dev/api/image/$id -H "Authorization: Bearer $API_SECRET" -o out.png
```

| Method | Path | |
|---|---|---|
| POST | `/api/generate` | `{prompt, steps?, width?, height?, seed?}` → **202** `{id,status}` |
| GET | `/api/tasks/:id` | task status + `progress` + `seed`/`generationMs` when done |
| GET | `/api/image/:id` | the PNG (409 until done, 404 if unknown) |
| POST | `/api/load` | load the model without the UI (202); ~15 min first time |
| GET | `/api/status` | worker present? model ready? load phase |
| GET | `/api/health` | liveness (unauthenticated) |

Every route but `/api/health` needs `Authorization: Bearer $API_SECRET`, and
fails closed (503 with no secret set). One job at a time (one GPU): the rest get
429.

### Why task-based (not synchronous)

Bonsai and rag-local return the result on the same request because generation is
seconds. A diffusion image is ~30–50 s (measured: 33–51 s at 512×512, 4 steps on
an Intel Xe-LPG). Holding an HTTP connection that long through the edge is
fragile — the synchronous first cut failed exactly there. So `POST /api/generate`
returns a task id at once, and the caller polls. Short requests only.

Measured end-to-end: `queued → running (step 1/4 … 4/4) → done` in ~33 s, then a
769 KB **512×512 PNG** downloaded and confirmed (magic bytes + IHDR + it's
actually a red maple bonsai).

## How the worker drives the app

The app is a Vite bundle with **no exports and nothing on `window`** — so the
worker (`worker.js`, injected via a `<script>` in index.html) manipulates the
DOM:

- **Generate:** set `#prompt` + the size/steps/seed controls (dispatching `input`
  so the app's internal state syncs), click `#generateBtn`, watch the button text
  for `step N/4` progress, then read the finished image from IndexedDB
  `imgen_db_v1` store `images` — which the app fills with
  `{blob(PNG), seed, steps, width, height, generationMs, modelId}`. Reading a
  schema'd store beats scraping the DOM. The PNG goes up via `/api/blob`
  (binary), never through the JSON mailbox.
- **Load:** click `#tryDemoBtn` and wait for the model to be ready, heart-beating
  `/api/status` so a 15-min first load doesn't look dead.

## Traps hit while building this (all fixed)

- **Readiness is not `loadingStatus === "ready"`.** That text shows for an
  instant when loading finishes, then the UI moves to the generate view and it's
  gone — so a point check right before generating returned "not loaded". Fixed
  with a 1 s poll that **latches** ready on either signal (that text *or*
  none of landing/loading/gate sections visible + `#generateBtn` present); once
  loaded the model stays in VRAM until reload.
- **`[id].js` and `[id]/image.js` at the same level collide** in Pages routing —
  Pages served the SPA instead of the function. Moved the image to its own tree,
  `/api/image/[id].js`.
- **Two tabs on one mailbox.** A stale worker tab kept polling (clearing
  `localStorage` doesn't stop a running worker — it holds the secret in memory),
  competing for jobs and overwriting `/api/status`. Navigate the tab off the
  origin to actually stop it.
- **A Pages secret only reaches deployments made after it** (same as the other
  projects): redeploy after `wrangler pages secret put`.
- **`functions/` must stay at the project root**, never inside the output dir.

## Environmental note

The model would not finish a **cached** load in the sandbox browser used during
development — its Cache API is broken (`Cache.put() encountered a network error`,
the same wall Bonsai hit). A fresh download reached ready in ~15 min; the cached
reload hung on "opening". A normal Chrome does not have this problem — the full
flow above was verified in one.

## Deploy

```sh
# assemble: upstream index.html (with <script src="/worker.js"> injected) +
# assets/ + worker.js into _site; functions/ stays at the repo root.
wrangler pages project create <proj> --production-branch main
wrangler pages secret put API_SECRET          # then redeploy
wrangler pages deploy _site --project-name <proj>
```
