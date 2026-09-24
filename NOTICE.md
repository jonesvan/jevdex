# Notices and third-party licenses

JevDex bundles or derives from the following projects. The full license texts ship
with the sources linked below; the browser libraries under `public/vendor/` keep
their own headers.

## Laya

- Project: Laya — non-autoregressive typed decision models
- Author: ConvAI Innovations
- Source: https://github.com/NandhaKishorM/laya
- License: Apache License 2.0

`public/laya-core.js` is a JavaScript port of Laya's `laya/common.py`
(`build_sequence`) and `laya/agent.py` (`system_one`), adapted to build input
tensors for the exported ONNX graph and to run it with ONNX Runtime Web. It is
based on the port in `vishalmysore/layaForWeb` (Apache-2.0).

The ONNX weights are downloaded at runtime from Hugging Face
(`VishalMysore/layaForWeb`), an Apache-2.0 conversion of the Laya English
checkpoint `convaiinnovations/laya` (also Apache-2.0).

Laya is an unofficial build for the browser. It is not affiliated with ConvAI
Innovations. Decision models return probabilities, not facts; check the confidence
values before relying on them.

## ONNX Runtime Web

- Project: ONNX Runtime
- Source: https://github.com/microsoft/onnxruntime
- License: MIT
- Bundled as `public/vendor/ort.min.mjs` and
  `public/vendor/ort-wasm-simd-threaded.jsep.{mjs,wasm}` (onnxruntime-web 1.30.0).

## @huggingface/tokenizers

- Project: Hugging Face tokenizers (JavaScript bindings)
- Source: https://github.com/huggingface/tokenizers
- License: Apache License 2.0
- Bundled as `public/vendor/tokenizers.min.mjs` (version 0.2.0).

## Wikipedia data

Article titles, summaries and links come from Wikimedia pageviews and the MediaWiki
Action API and are available under CC BY-SA. See the Wikimedia terms of use:
https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use
