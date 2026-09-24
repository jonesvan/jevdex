# JevDex

A static website that searches a fixed index of **1000 English Wikipedia articles**
(title, summary, link) and ranks the results with a **decision model that runs in
your browser** — no server, no API key, nothing you type leaves the page.

The ranking model is **Laya** (ConvAI Innovations), a non-generative "System One"
decision model that reads text and typed questions and returns calibrated
probabilities. It is loaded and run locally with **ONNX Runtime Web**.

> Originally this demo was going to call **Jev** (TypeSafe's System One API) through
> Defapi. That route turned out to be unavailable (see *Known issue* below), so the
> default engine is now Laya running on-device. The remote Jev path is kept as an
> option in Settings.

## How it works

- `index.md` / `public/index.json` contain 1000 top-viewed Wikipedia articles
  (id, title, summary, link), built from the Wikimedia pageviews "top" endpoint
  and enriched with intro summaries from the MediaWiki Action API.
- The browser loads the whole index (`public/index.json`, ~0.6 MB).
- On a search:
  1. **Retrieve** — a small keyword pass scores every article and keeps the top 20
     candidates.
  2. **Rank with Laya** — one batched call sends the query as the model's `state`
     and asks:
     - one **Choice** question with the 20 candidate titles as options → the model
       returns a probability per candidate, which becomes the ranking;
     - one **Noul** question — *is the query a meaningful topic?*
  3. The top 12 candidates render as cards (title, summary, link, match %).
- If the model is not loaded or a call fails, the page falls back to a simple
  lexical search so cards still appear.

### Why not send the whole index to the model?

Laya reads about **512 tokens of context** (`head_max_len = 192` of which is the
question/options) and takes roughly **20 options per Choice** question. 1000
article summaries do not fit, so JevDex does retrieval first and lets Laya do the
re-ranking. This is the practical difference from the original Jev design, which
assumed a large shared context.

## Requirements

- Node.js >= 18 (only for the build script and optional static server)
- A browser with WebAssembly (WebGPU is used automatically for the int4 build when
  available)

The model weights (~291 MB for the default int4 build) are downloaded from
Hugging Face on first use and cached in the browser's Cache Storage. Re-visits do
not re-download them.

## Setup

```bash
npm run build   # regenerate index.md + public/index.json (1000 articles)
npm run serve   # serve ./public on a local port
```

Then open the served URL (the page must be served over HTTP — ES modules and Cache
Storage do not work from `file://`). Expand **Settings** and press **Load Laya
model**. Progress is shown; after it finishes, search.

## Settings

- **Decision engine**
  - **Laya — in-browser** (default): downloads the ONNX build once, runs locally.
  - **Jev — remote API**: sends `{ state, model, questions }` to a System One
    endpoint with `Authorization: Bearer <key>` (the original design).
- **Laya model base URL**: defaults to the model published by
  [`vishalmysore/layaForWeb`](https://huggingface.co/VishalMysore/layaForWeb).
- **Build**: `int4` (q4e8, ~291 MB, the default and the only one WebGPU can run)
  or `int8` (q8e8, ~442 MB, closest to the original).
- **Jev endpoint / model / key**: only used by the remote engine; the key is kept
  in `localStorage` and never committed.

## Files

```
index.md                    generated index, human-readable
public/
  index.html  styles.css  app.js   the site
  laya.js                          model loader (Hugging Face + Cache Storage) and rank()
  laya-core.js                     line-by-line JS port of Laya's sequence builder + systemOne
  vendor/                          onnxruntime-web + @huggingface/tokenizers browser builds
  index.json                       generated index, machine-readable
scripts/build_index.mjs            Wikipedia pageviews -> enrich -> index.md + index.json
```

## Known issue: Defapi does not expose System One

`api.defapi.org` only registers `/v1/chat/completions` and `/v1/messages`; it does
**not** expose `POST /v1/systemone` (404), and every `typesafe/jev-1.13` call on
the OpenAI-compatible routes returns `{"code":500}`. The native TypeSafe endpoint
`https://api.typesafe.ai/v1/systemone` works but needs a TypeSafe key. That is why
the in-browser Laya engine is the default; the remote Jev engine still supports any
endpoint that speaks the System One protocol.

## Security

The site is fully static. Any API key you enter for the remote engine is exposed to
whoever loads the page, so only use a throwaway key. The key lives only in
`localStorage`; nothing here reads a key from a file. Do not commit keys.

## Data and model credits

- Article data from Wikipedia (CC BY-SA) via Wikimedia pageviews and the MediaWiki API.
- **Laya** by ConvAI Innovations — <https://github.com/NandhaKishorM/laya> (Apache-2.0).
- ONNX build and JS port derived from
  [`vishalmysore/layaForWeb`](https://github.com/vishalmysore/layaForWeb) (Apache-2.0).
- **ONNX Runtime Web** (MIT) and **@huggingface/tokenizers** (Apache-2.0).

See [NOTICE.md](NOTICE.md) for details.
