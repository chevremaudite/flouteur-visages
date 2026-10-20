#!/usr/bin/env bash
# Prepares public/: exports deface's CenterFace model with dynamic input shapes
# and copies the browser runtimes (onnxruntime-web, ffmpeg.wasm) into public/vendor.
set -euo pipefail
cd "$(dirname "$0")"

[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q deface==1.5.0 onnx
npm ci --silent

mkdir -p public/models
.venv/bin/python - <<'EOF'
import onnx
from deface.centerface import CenterFace, default_onnx_path
model = CenterFace.dynamicize_shapes(onnx.load(default_onnx_path))
# Weights are also listed as graph inputs (old exporter), which blocks onnxruntime's
# constant folding / conv+batchnorm fusion. Drop them from the inputs.
weights = {init.name for init in model.graph.initializer}
for inp in [i for i in model.graph.input if i.name in weights]:
    model.graph.input.remove(inp)
used = {name for node in model.graph.node for name in node.input}
for init in [i for i in model.graph.initializer if i.name not in used]:
    model.graph.initializer.remove(init)
onnx.save(model, 'public/models/centerface-dynamic.onnx')
EOF

rm -rf public/vendor
mkdir -p public/vendor/ort public/vendor/ffmpeg public/vendor/ffmpeg-core public/vendor/mediabunny
cp node_modules/onnxruntime-web/dist/ort.{wasm,webgpu}.min.mjs \
   node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded{,.asyncify}.{mjs,wasm} public/vendor/ort/
cp node_modules/mediabunny/dist/bundles/mediabunny.min.mjs public/vendor/mediabunny/
cp node_modules/@ffmpeg/ffmpeg/dist/esm/*.js public/vendor/ffmpeg/
cp node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.{js,wasm} public/vendor/ffmpeg-core/


# Precompress text and WASM once, so Caddy never compresses on the fly (the model
# itself doesn't compress).
find public -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.wasm' -o -name '*.css' -o -name '*.html' \) -size +1k | while read -r f; do
  zstd -q -19 -f "$f" -o "$f.zst"
  gzip -9 -k -f "$f"
done
echo "OK: fichiers précompressés"
