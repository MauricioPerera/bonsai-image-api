#!/usr/bin/env bash
# Ensambla el sitio (index.html upstream + worker.js + assets) y deploya.
# functions/ queda en la raíz. Correr desde este directorio.
set -e
UP="${1:-../bonsai-image-webgpu}"   # el clon del Space de HF
rm -rf _site && mkdir -p _site
node -e "const fs=require('fs');let h=fs.readFileSync('$UP/index.html','utf8');if(!h.includes('/worker.js'))h=h.replace('</body>','  <script src=\"/worker.js\"></script>\n</body>');fs.writeFileSync('_site/index.html',h);fs.copyFileSync('worker.js','_site/worker.js');"
cp -r "$UP/assets" _site/
wrangler pages deploy _site --project-name bonsai-image --branch main --commit-dirty true
rm -rf _site
