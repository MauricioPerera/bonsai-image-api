# bonsai-image-api

Turn the **Bonsai Image** WebGPU model into an HTTP API you can call from
anywhere — on Cloudflare Pages, free tier, no server.

The image model runs **entirely in a browser tab** (WebGPU, ~3.2 GB, prism-ml's
1-bit/2-bit diffusion model). That tab *is* the worker: the API relays your
requests to it and hands back the PNG. Nothing runs on a server, and no image
data is stored anywhere — it flows request → tab → response.

```sh
# start a job (returns a task id immediately)
curl -X POST https://YOUR-PROJECT.pages.dev/api/generate \
  -H "Authorization: Bearer $API_SECRET" -H 'Content-Type: application/json' \
  -d '{"prompt":"a red maple bonsai on a stone table"}'
# {"id":"…","status":"queued","poll":"/api/tasks/…","image":"/api/image/…"}
```

## What you need

- A **Cloudflare account** (the free plan is enough).
- **One browser tab** open with the model loaded — it does the work. Chromium
  (Chrome/Edge) with WebGPU; ~3.2 GB downloads once and is cached.

## Deploy it (two ways)

### A) One command (Wrangler CLI)

```sh
git clone https://github.com/MauricioPerera/bonsai-image-api
cd bonsai-image-api
npm install

npx wrangler pages project create bonsai-image --production-branch main
npx wrangler pages secret put API_SECRET        # type any secret you choose
npm run deploy                                  # builds + deploys
```

> On Windows, if PowerShell blocks `wrangler.ps1`, use `wrangler.cmd` (its
> execution policy blocks `.ps1`, not `.cmd`).

### B) Connect the repo in the dashboard

1. Fork this repo.
2. Cloudflare → **Workers & Pages → Create → Pages → Connect to Git** → pick your
   fork.
3. Build command: `npm run build` · Output directory: `_site`
4. After the first deploy: **Settings → Variables and Secrets → add `API_SECRET`**
   (a secret you choose), then **redeploy** — a Pages secret only reaches
   deployments made *after* it exists.

The build downloads the Bonsai Image app from Hugging Face and injects the worker
— nothing to vendor, always the current version.

## Use it

After deploying, open **`https://YOUR-PROJECT.pages.dev/`**, click to load the
model (first time ~15 min for the 3.2 GB download; instant after that), and paste
your `API_SECRET` into the small **API worker** panel (bottom-right). When it says
*“escuchando — modelo listo”*, the API is live while that tab stays open.

```sh
S="your-secret"; U="https://YOUR-PROJECT.pages.dev"

id=$(curl -s -X POST "$U/api/generate" -H "Authorization: Bearer $S" \
  -H 'Content-Type: application/json' -d '{"prompt":"a bonsai tree"}' | jq -r .id)

# poll: queued -> running (with "step 3/4" progress) -> done
curl -s "$U/api/tasks/$id" -H "Authorization: Bearer $S"

# download the PNG once done
curl -s "$U/api/image/$id" -H "Authorization: Bearer $S" -o out.png
```

| Method | Path | |
|---|---|---|
| POST | `/api/generate` | `{prompt, steps?, width?, height?, seed?}` → `{id}` |
| GET | `/api/tasks/:id` | status: `queued → running → done` (+ `progress`, `seed`, `generationMs`) |
| GET | `/api/image/:id` | the PNG (409 until done) |
| POST | `/api/load` | load the model without the UI (202) |
| GET | `/api/status` | is a tab listening? is the model ready? |
| GET | `/api/health` | liveness (no auth) |

Every route but `/api/health` requires `Authorization: Bearer $API_SECRET` and
fails closed. One image at a time (one GPU) — the rest get `429`.

## Good to know

- **The tab is the worker.** Close it and the API answers `503`. It must be armed
  by hand once per session — a browser tab can't be reached from outside, so it
  reaches out (long-polls) and generation runs on its GPU.
- **Task-based on purpose.** A diffusion image takes ~30–50 s; holding an HTTP
  connection that long through the edge is fragile. So `generate` returns a task
  id at once and you poll — short requests only.
- **First model load is ~15 minutes** (3.2 GB from Hugging Face), cached
  afterwards. `POST /api/load` starts it without the UI; watch `/api/status`.
- **Rotate the secret** if you expose this, and remember a Pages secret needs a
  redeploy to take effect.
- **Runs on the free plan.** Static hosting and the model download (from Hugging
  Face) cost you nothing; you provide the GPU by keeping the tab open.

## How it works

The Bonsai Image app exposes nothing on `window`, so `worker.js` (injected into
the page at build) drives its DOM — sets `#prompt` + the controls, clicks
`#generateBtn`, reads `step N/4` progress off the button, and pulls the finished
image out of the app's own IndexedDB (`imgen_db_v1`, which stores
`{blob(PNG), seed, steps, width, height, generationMs}`). The PNG travels a
binary channel (`/api/blob`), never base64 in JSON. `functions/api/` is the
mailbox the tab polls; `build.mjs` assembles the deployable site.

## Not included / attribution

This repo is the **API layer only**. The build downloads, but does not
redistribute:

- **App:** [`webml-community/bonsai-image-webgpu`](https://huggingface.co/spaces/webml-community/bonsai-image-webgpu)
- **Models:** [`prism-ml/bonsai-image-ternary-4B-mlx-2bit`](https://huggingface.co/prism-ml/bonsai-image-ternary-4B-mlx-2bit),
  [`prism-ml/bonsai-image-binary-4B-mlx-1bit`](https://huggingface.co/prism-ml/bonsai-image-binary-4B-mlx-1bit)

Those belong to their authors, under their own terms. MIT for the code here.
