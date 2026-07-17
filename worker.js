// worker.js — inyectado en la página de Bonsai Image para atender la API.
//
// Esta app NO expone nada en window (es un bundle de Vite, cero exports), así
// que el worker maneja el DOM: setea #prompt y los sliders, clickea
// #generateBtn, y lee el resultado de IndexedDB `imgen_db_v1` (store `images`),
// que la app llena con { blob(PNG), seed, steps, width, height, generationMs,
// modelId }. No se raspa el DOM para el resultado: se lee de una base con
// esquema, más robusto que un scrape.
//
// La imagen sube por /api/blob (binario), la metadata baja por /api/result.
// Mismo patrón de buzón que Bonsai/rag-local: la pestaña pollea /api/next porque
// un Function no puede llamar al navegador.

(function () {
  'use strict';
  const KEY = 'bonsai_image_api_secret';
  let secret = localStorage.getItem(KEY) || '';
  let on = true;
  let busy = false; // durante load/generate no reclamamos otro trabajo

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const auth = () => ({ Authorization: 'Bearer ' + secret });

  // ── panel flotante para el secreto (la página no es nuestra) ──────────────
  function panel() {
    const p = document.createElement('div');
    p.style.cssText =
      'position:fixed;right:12px;bottom:12px;z-index:99999;background:#0b0d10ee;color:#e6e6e6;' +
      'border:1px solid #2f6b52;border-radius:8px;padding:.6rem .7rem;font:12px system-ui;max-width:280px;backdrop-filter:blur(4px)';
    p.innerHTML =
      '<div style="font-weight:600;margin-bottom:.35rem">API worker</div>' +
      '<input id="__apiSecret" type="password" placeholder="API_SECRET" style="width:150px;padding:3px;background:#111;color:#e6e6e6;border:1px solid #333;border-radius:4px">' +
      '<button id="__apiSave" style="margin-left:4px;padding:3px 8px;cursor:pointer">guardar</button>' +
      '<div id="__apiStatus" style="opacity:.75;margin-top:.35rem">esperando el modelo…</div>';
    document.body.appendChild(p);
    if (secret) $('__apiSecret').placeholder = 'guardado — pegá otro';
    $('__apiSave').addEventListener('click', () => {
      secret = $('__apiSecret').value.trim();
      if (secret) localStorage.setItem(KEY, secret); else localStorage.removeItem(KEY);
      $('__apiSecret').value = '';
      $('__apiSecret').placeholder = secret ? 'guardado — pegá otro' : 'API_SECRET';
    });
  }
  const wstatus = (s) => { const el = $('__apiStatus'); if (el) el.textContent = s; };

  // ── validador de requisitos (corre al cargar, ANTES de bajar 3.2 GB) ───────
  // Honestidad: este runtime pide las features/limits que el dispositivo TENGA y
  // adapta los kernels — no declara un mínimo duro (a diferencia del Bonsai LLM,
  // cuyo kernel SSM exigía `subgroups`). Así que esto NO promete "va a andar":
  // atrapa lo que con certeza NO puede (sin WebGPU, sin adapter, disco corto) y
  // reporta el resto con contexto, sin inventar umbrales.
  async function deviceCheck() {
    const wrap = document.createElement('div');
    wrap.style.cssText =
      'position:fixed;left:12px;top:12px;z-index:99999;background:#0b0d10f2;color:#e6e6e6;' +
      'border:1px solid #2a3038;border-radius:8px;padding:.7rem .8rem;font:12px system-ui;max-width:320px;backdrop-filter:blur(4px)';
    wrap.innerHTML = '<div style="font-weight:600;margin-bottom:.35rem">Requisitos del dispositivo</div><div id="__devBody">comprobando…</div>';
    document.body.appendChild(wrap);
    const body = wrap.querySelector('#__devBody');

    const GB = (n) => (n / 1073741824).toFixed(2) + ' GB';
    const rows = [];
    const blockers = [];
    const row = (k, v, bad) => rows.push(`<div style="display:flex;justify-content:space-between;gap:1rem"><span style="opacity:.65">${k}</span><span${bad ? ' style="color:#ff6b6b"' : ''}>${v}</span></div>`);

    if (!navigator.gpu) {
      body.innerHTML = '<div style="color:#ff6b6b"><strong>Sin WebGPU.</strong> Este navegador no puede ejecutar el modelo. Usá Chrome o Edge de escritorio recientes.</div>';
      return;
    }
    let adapter = null;
    try { adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch {}
    if (!adapter) {
      body.innerHTML = '<div style="color:#ff6b6b"><strong>WebGPU sin adapter.</strong> La GPU de este dispositivo no está disponible para el navegador.</div>';
      return;
    }
    const i = adapter.info || {}, L = adapter.limits || {}, F = adapter.features;
    row('GPU', (i.vendor || '?') + ' · ' + (i.architecture || i.description || '?'));

    // shader-f16: todos los kernels de matmul lo piden. Sin él, muy probablemente
    // no funcione — pero lo marco como aviso, no como bloqueo, porque el runtime
    // podría tener algún camino que no vi.
    const f16 = F && F.has('shader-f16');
    row('shader-f16', f16 ? 'sí' : 'NO (los matmul lo usan)', !f16);
    row('subgroups (acelera)', F && F.has('subgroups') ? 'sí' : 'no');
    row('subgroup-matrix (acelera)', F && F.has('chromium-experimental-subgroup-matrix') ? 'sí' : 'no');

    const sb = L.maxStorageBufferBindingSize || 0;
    // No invento un mínimo. Reporto el número; solo señalo el rango típico de
    // móviles (~128-256 MB), muy por debajo de un desktop (2 GB), como aviso.
    row('maxStorageBufferBindingSize', GB(sb) + (sb <= 268435456 ? ' (típico de móvil)' : ''), sb <= 268435456);
    row('maxBufferSize', GB(L.maxBufferSize || 0));

    let quota = 0;
    try { quota = (await navigator.storage.estimate()).quota || 0; } catch {}
    // Disco: bloqueo REAL y chequeable. El modelo cacheado son ~3.2 GB.
    const diskOK = quota >= 4 * 1073741824;
    if (!diskOK) blockers.push(`el disco disponible (${GB(quota)}) no entra el modelo de ~3.2 GB`);
    row('Disco (necesita ≥4 GB)', GB(quota), !diskOK);

    let verdict;
    if (blockers.length) {
      verdict = '<div style="color:#ff6b6b;margin-top:.5rem"><strong>No puede correr el modelo:</strong><ul style="margin:.2rem 0 0;padding-left:1.1rem">' + blockers.map((b) => '<li>' + b + '</li>').join('') + '</ul></div>';
    } else if (!f16) {
      verdict = '<div style="color:#e8a55e;margin-top:.5rem">Cumple lo básico pero <strong>falta shader-f16</strong>, que los matmul usan — puede que no funcione. Probá igual.</div>';
    } else {
      verdict = '<div style="color:#53e6a6;margin-top:.5rem"><strong>Cumple los requisitos chequeables.</strong> El modelo se adapta a tu GPU. Descarga: ~3.2 GB la primera vez.</div>';
    }
    body.innerHTML = rows.join('') + verdict +
      '<div style="opacity:.5;margin-top:.4rem;font-size:11px">Este modelo no declara un mínimo duro: pide lo que tu GPU tenga. Esto atrapa lo que con certeza no puede; el resto se prueba corriendo.</div>';
  }

  // ── señales del estado de la app ──────────────────────────────────────────
  const vis = (el) => !!(el && el.offsetParent);
  function loadPhase() {
    const s = ($('loadingStatus') || {}).textContent || '';
    return s.trim();
  }
  // Readiness. loadingStatus pasa a "ready" un INSTANTE al terminar la carga y
  // luego la UI cambia a la vista de generación y ese texto se va — así que
  // "ready" es transitorio y no sirve como chequeo puntual (me dio false justo
  // al generar). Dos señales, y latcheo: una vez visto listo, queda listo (el
  // modelo no se descarga de VRAM sin recargar la página, que reinicia esto).
  let sawReady = false;
  function readyNow() {
    if (loadPhase().toLowerCase() === 'ready') return true;
    // O bien: estamos en la vista de app (ni landing, ni carga, ni gate) y el
    // botón de generar existe. Esta señal es estable, no transitoria.
    return !!$('generateBtn') && !vis($('landingSection')) && !vis($('loadingSection')) && !vis($('gateSection'));
  }
  setInterval(() => { if (readyNow()) sawReady = true; }, 1000);
  function isReady() { return sawReady; }

  // ── IndexedDB de imágenes ──────────────────────────────────────────────────
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('imgen_db_v1');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function imageRows() {
    const db = await openDB();
    try {
      if (!db.objectStoreNames.contains('images')) return [];
      return await new Promise((res, rej) => {
        const q = db.transaction('images', 'readonly').objectStore('images').getAll();
        q.onsuccess = () => res(q.result || []);
        q.onerror = () => rej(q.error);
      });
    } finally { db.close(); }
  }
  const newestBy = (rows) => rows.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];

  // ── setear un control y avisarle a la app (sincroniza el estado Q) ─────────
  function setControl(id, value) {
    const el = $(id);
    if (!el || value == null) return;
    el.value = String(value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── operaciones ────────────────────────────────────────────────────────────
  async function opLoad() {
    if (isReady()) return; // ya está
    const btn = $('tryDemoBtn') || $('continueBtn');
    if (btn) btn.click();
    // esperar hasta 'ready', latiendo con peek para que /api/status vea progreso
    const deadline = Date.now() + 20 * 60 * 1000; // 20 min de techo
    while (Date.now() < deadline) {
      if (isReady()) return;
      const cont = $('continueBtn');
      if (vis(cont) && !cont.disabled) cont.click(); // por si hay un paso intermedio
      await heartbeat();
      await sleep(3000);
    }
    throw new Error('la carga no llegó a ready en 20 min');
  }

  async function opGenerate(a, onProgress) {
    if (!isReady()) throw new Error('modelo no cargado — hacé POST /api/load primero');

    const antes = (await imageRows()).length;
    setControl('prompt', a.prompt);
    if (a.seed != null) setControl('seedInput', a.seed);
    if (a.steps != null) setControl('stepsSlider', a.steps);
    if (a.width != null) setControl('widthSlider', a.width);
    if (a.height != null) setControl('heightSlider', a.height);
    await sleep(200);

    const btn = $('generateBtn');
    if (!btn) throw new Error('no encontré #generateBtn');
    if (btn.disabled) throw new Error('el botón de generar está deshabilitado (¿prompt vacío?)');
    btn.click();

    // Esperar a que aparezca una fila nueva. Mientras, el texto del botón dice
    // "step 2/4 · 30.0s" — lo reporto como progreso.
    const deadline = Date.now() + 5 * 60 * 1000;
    let row = null, lastProg = '';
    while (Date.now() < deadline) {
      await sleep(1500);
      const prog = (btn.textContent || '').trim();
      if (prog && prog !== lastProg && onProgress) { lastProg = prog; onProgress(prog); }
      const rows = await imageRows();
      if (rows.length > antes) { row = newestBy(rows); break; }
    }
    if (!row) throw new Error('no apareció ninguna imagen en 5 min');
    if (!(row.blob instanceof Blob)) throw new Error('la fila no trae un blob de imagen');

    return {
      blob: row.blob,
      meta: {
        seed: row.seed, steps: row.steps, width: row.width, height: row.height,
        generationMs: Math.round(row.generationMs || 0), model: row.modelId, prompt: row.prompt,
      },
    };
  }

  // ── heartbeat: reportar estado sin reclamar trabajo ─────────────────────────
  async function heartbeat() {
    if (!secret) return;
    const q = `?peek=1&ready=${isReady() ? 1 : 0}&busy=${busy ? 1 : 0}&phase=${encodeURIComponent(loadPhase())}&pct=0`;
    try { await fetch('/api/next' + q, { headers: auth(), cache: 'no-store' }); } catch {}
  }

  // ── loop principal ──────────────────────────────────────────────────────────
  async function loop() {
    for (;;) {
      if (!on) { wstatus('desactivado'); await sleep(1000); continue; }
      if (!secret) { wstatus('pegá el API_SECRET acá'); await sleep(2000); continue; }
      if (busy) { await sleep(1000); continue; }
      try {
        const q = `?ready=${isReady() ? 1 : 0}&busy=${busy ? 1 : 0}&phase=${encodeURIComponent(loadPhase())}&pct=0`;
        wstatus(isReady() ? 'escuchando — modelo listo' : 'escuchando — sin modelo (POST /api/load)');
        const r = await fetch('/api/next' + q, { headers: auth(), cache: 'no-store' });
        if (r.status === 401) { secret = ''; localStorage.removeItem(KEY); wstatus('API_SECRET inválido'); await sleep(2000); continue; }
        if (r.status === 503) { wstatus('API_SECRET sin configurar en el server'); await sleep(5000); continue; }
        if (r.status === 404) { wstatus('no hay /api acá (¿servís sin Functions?)'); await sleep(5000); continue; }
        if (r.status !== 200) continue; // 204: long-poll vencido

        const job = await r.json();
        busy = true;

        if (job.op === 'load') {
          wstatus('cargando el modelo…');
          const beat = setInterval(heartbeat, 5000);
          try { await opLoad(); await ack(job.id, { value: { ready: isReady() } }); }
          catch (e) { await ack(job.id, { error: e.message, status: 500 }); }
          finally { clearInterval(beat); }
          wstatus(isReady() ? 'modelo listo' : 'la carga falló');
        } else if (job.op === 'generate') {
          wstatus('generando: ' + String(job.args?.prompt || '').slice(0, 40));
          try {
            await ack(job.id, { status: 'running', progress: 'starting' });
            const onProgress = (p) => { ack(job.id, { status: 'running', progress: p }); wstatus('generando · ' + p); };
            const { blob, meta } = await opGenerate(job.args || {}, onProgress);
            // El PNG sube ANTES de marcar done, así el GET /image lo encuentra.
            const up = await fetch(`/api/blob?id=${encodeURIComponent(job.blobId)}`, {
              method: 'POST', headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth()), body: blob,
            });
            if (!up.ok) throw new Error(`no pude subir el PNG: ${up.status}`);
            await ack(job.id, { status: 'done', value: meta });
            wstatus(`lista en ${(meta.generationMs / 1000).toFixed(1)}s`);
          } catch (e) { await ack(job.id, { status: 'error', error: e.message }); wstatus('error: ' + e.message); }
        } else {
          await ack(job.id, { error: `operación no permitida: ${job.op}`, status: 400 });
        }
      } catch (e) {
        wstatus('error de red: ' + ((e && e.message) || e));
        await sleep(2000);
      } finally { busy = false; }
    }
  }

  function ack(id, payload) {
    return fetch('/api/result', {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, auth()),
      body: JSON.stringify(Object.assign({ id }, payload)),
    });
  }

  function init() { panel(); deviceCheck(); loop(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
