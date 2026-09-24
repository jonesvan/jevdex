# JevDex

A static website that searches a fixed index of **1000 English Wikipedia articles**
using the **Jev** (TypeSafe AI "System One") decision API, brokered by
[Defapi](https://defapi.org).

## How it works

- `index.md` / `public/index.json` contain 1000 top-viewed Wikipedia articles
  (id, title, summary, link), built from the Wikimedia pageviews "top" endpoint
  and enriched with intro summaries from the MediaWiki Action API.
- On a search, the browser sends the **entire index** as the Jev `state` and asks:
  - one **Noul** question — *is the query a meaningful topic?*
  - five **Choice** questions — one per block of 200 article ids (Choice is capped
    at 255 options), each asking which article in the block best matches the query.
- The probability distributions from all blocks are merged into a ranking, and the
  top 12 render as cards (title, summary, link, match %).
- If the API/key is missing or the request fails, the page falls back to a simple
  lexical search so cards still appear.

Jev is a non-generative decision model: it returns typed answers and calibrated
probabilities, not text. That is why the "results" are produced by ranking the
index against the model's per-block probabilities.

## Requirements

- Node.js >= 18 (only for the build script and optional static server)
- A Defapi API key with access to `typesafe/jev-1.13`

## Setup

```bash
npm run build   # regenerate index.md + public/index.json (1000 articles)
npm run serve   # serve ./public on a local port
```

Then open the served URL, expand **Settings**, paste your API key and click
**Save settings**. The key, endpoint URL, and model are kept in this browser's
`localStorage` only.

## Search endpoint

The app POSTs the System One request shape to the URL configured in Settings
(default `https://api.defapi.org/v1/systemone`):

```
POST <endpoint>
Authorization: Bearer <API_KEY>
Content-Type: application/json

{ "state": { "query": "...", "articles": [ ... 1000 ... ] },
  "model": "typesafe/jev-1.13",
  "questions": { "query_meaningful": {...}, "block_0": {...}, ... } }
```

### Known issue: Defapi does not expose System One

As of this build, `api.defapi.org` only registers `/v1/chat/completions` and
`/v1/messages`; it does **not** expose `POST /v1/systemone` (404) and every
`typesafe/jev-1.13` call on the OpenAI-compatible routes returns `{"code":500}`
(other models such as `google/gemini-3.8-flash` work, so the key is fine). The
native TypeSafe endpoint `https://api.typesafe.ai/v1/systemone` works but needs a
TypeSafe key.

To use Jev, set the endpoint in **Settings** to a URL that speaks the System One
protocol. Against TypeSafe directly, use:

- Endpoint: `https://api.typesafe.ai/v1/systemone`
- Model: `jev-latest` (or `typesafe/jev-1.13` via a gateway that supports it)
- Key: a TypeSafe API key

Until then the page still works, using the lexical fallback and showing the exact
API error.

## Security

The site is fully static, so any API key used in the browser is exposed to whoever
loads the page. Nothing here reads a key from a file; the key lives only in
`localStorage`. Do not commit keys.

## Data credits

Article data from Wikipedia (CC BY-SA) via Wikimedia pageviews and the MediaWiki API.
