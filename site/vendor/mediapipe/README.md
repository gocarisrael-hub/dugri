# Vendored: MediaPipe Tasks Vision + the selfie-multiclass segmenter

These files remove the background from a buyer's pawn photo **in the buyer's own
browser** (`site/js/pawn-cutout.js`). Nothing here talks to a CDN or to any host
but ours: with the outside world unreachable the cut still works, because the
files are served from this origin.

## What is here, and where each file came from

| file                          | source                                                                                                      | size            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------- |
| `vision_bundle.mjs`           | npm `@mediapipe/tasks-vision@1.0.1` → `vision_bundle.mjs`                                                    | 152 KB          |
| `vision_wasm_internal.js`     | npm `@mediapipe/tasks-vision@1.0.1` → `wasm/vision_wasm_internal.js`                                          | 316 KB          |
| `vision_wasm_internal.wasm.br`| npm `@mediapipe/tasks-vision@1.0.1` → `wasm/vision_wasm_internal.wasm`, brotli -q11                          | 2.3 MB (11.8 raw) |
| `selfie_multiclass_256x256.tflite` | `https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite` | 15.6 MB |
| `LICENSE`                     | google-ai-edge/mediapipe `LICENSE` (Apache-2.0)                                                              | 12 KB           |

The `.wasm` is stored **brotli-precompressed only** and served with
`Content-Encoding: br` by the `/vendor/:dir/:file` route in `server/index.js` —
2.3 MB on the wire instead of 11.8 MB. The `.tflite` is stored raw: it is float32
weights and compresses by only ~9%, so a second copy would cost more in the repo
than it saves on the wire.

Only the **SIMD** wasm is vendored, not the `nosimd` fallback. Every browser that
can run this has had WebAssembly SIMD since 2021; a browser without it fails to
load the segmenter, which is a normal cut miss (the original photo is used and the
owner is told). That decision halves what the repo and the image carry.

## Licences — both permit commercial use

This is a paid product, so both halves were checked, because a permissive code
licence next to restricted weights is the usual trap here.

- **Runtime** — `@mediapipe/tasks-vision` is **Apache-2.0**
  (https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE); the npm
  package's own `license` field says the same. The `.wasm` binaries ship inside
  the package, so self-hosting is both permitted and the documented path.
- **Weights** — the SelfieMulticlass model card states, verbatim, `LICENSED UNDER
  → Apache License, Version 2.0`:
  https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf
  (Adel Ahmadyan, Google, 10 May 2023). No non-commercial clause, no separate
  dataset terms attached to the weights.

Apache-2.0 asks that we keep the licence and attribution with the files: that is
what `LICENSE` here is for. Copyright is Google LLC's.

Models that were rejected on licence grounds, for the record: BRIA RMBG-1.4/2.0
(CC BY-NC — commercial use needs a paid BRIA agreement), `@imgly/background-removal`
(AGPL-3.0, and it never states the licence of the isnet weights it fetches), and
`isnet-general-use` / IS-Net (the DIS repo licenses "our code and evaluation
metric" under Apache-2.0 but never the weights, and DIS5K's terms of use forbid
commercial use).

## Re-vendoring

```sh
npm pack @mediapipe/tasks-vision@1.0.1     # or npm i, then read node_modules/
cp .../vision_bundle.mjs .../wasm/vision_wasm_internal.js site/vendor/mediapipe/
node -e "const z=require('zlib'),f=require('fs');f.writeFileSync('site/vendor/mediapipe/vision_wasm_internal.wasm.br',z.brotliCompressSync(f.readFileSync('.../wasm/vision_wasm_internal.wasm'),{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}))"
curl -Lo site/vendor/mediapipe/selfie_multiclass_256x256.tflite \
  https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite
```

`tests/unit/pawn-cutout.test.js` fails if any of these files goes missing, so a
half-finished re-vendor cannot merge.
