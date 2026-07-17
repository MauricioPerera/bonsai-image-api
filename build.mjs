// build.mjs — arma _site/ para deployar.
//
// NO vendorizamos el bundle del Space ajeno: lo bajamos de Hugging Face acá, le
// inyectamos worker.js, y copiamos assets + functions. Así este repo es solo
// nuestro código, siempre toma la versión actual del Space (cuyo bundle tiene el
// nombre hasheado), y no redistribuye trabajo de terceros.
//
// Corre igual local (`npm run build`) o en el build de Cloudflare Pages (Node
// con fetch nativo, sin dependencias).

import { writeFile, mkdir, readFile } from 'node:fs/promises';

const SPACE =
  process.env.UPSTREAM ||
  'https://huggingface.co/spaces/webml-community/bonsai-image-webgpu/resolve/main';

async function dl(path) {
  const r = await fetch(`${SPACE}/${path}`);
  if (!r.ok) throw new Error(`no pude bajar ${path}: HTTP ${r.status}`);
  return r;
}

console.log(`bajando la app de ${SPACE}`);

// 1) index.html del Space
let html = await (await dl('index.html')).text();

// 2) encontrar el bundle (su nombre lleva un hash que cambia entre versiones)
const m = html.match(/src="(\/assets\/[^"']+\.js)"/);
if (!m) throw new Error('no encontré <script src="/assets/…js"> en index.html del Space');
const assetPath = m[1].replace(/^\//, ''); // assets/index-XXXXX.js

// 3) inyectar nuestro worker antes de </body>
if (!html.includes('/worker.js')) {
  html = html.replace('</body>', '  <script src="/worker.js"></script>\n</body>');
}

// 4) ensamblar _site
await mkdir('_site/assets', { recursive: true });
await writeFile('_site/index.html', html);
const asset = Buffer.from(await (await dl(assetPath)).arrayBuffer());
await writeFile(`_site/${assetPath}`, asset);
await writeFile('_site/worker.js', await readFile('worker.js'));

console.log(`_site listo — ${assetPath} (${Math.round(asset.length / 1024)} KB) + worker.js`);
console.log('functions/ se toma de la raíz del proyecto (no va dentro de _site).');
