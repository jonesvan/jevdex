// Loads the English Laya decision model in the browser with ONNX Runtime Web, and exposes a
// tiny ranking API used by the JevDex search. Weight parts are fetched from Hugging Face and
// cached in Cache Storage, so the (few hundred MB) download happens once per browser.
//
// Laya is by ConvAI Innovations (Apache-2.0). The ONNX build used here is the one published by
// vishalmysore/layaForWeb. See NOTICE.md for attribution.

import * as ort from './vendor/ort.min.mjs';
import { Tokenizer } from './vendor/tokenizers.min.mjs';
import { Laya } from './laya-core.js';

export const DEFAULT_BASE = 'https://huggingface.co/VishalMysore/layaForWeb/resolve/main/';
const BASE_KEY = 'jevdex.layaBase';
const VARIANT_KEY = 'jevdex.layaVariant';
const CACHE = 'jevdex-laya-v1';

export function getBase() {
  return localStorage.getItem(BASE_KEY) || DEFAULT_BASE;
}
export function setBase(v) {
  if (v) localStorage.setItem(BASE_KEY, v);
  else localStorage.removeItem(BASE_KEY);
}
export function getVariant() {
  return localStorage.getItem(VARIANT_KEY) || 'q4e8';
}
export function setVariant(v) {
  if (v) localStorage.setItem(VARIANT_KEY, v);
  else localStorage.removeItem(VARIANT_KEY);
}

const st = {
  status: 'idle', // idle | loading | ready | error
  message: '',
  progress: null, // 0..1 while loading weights, else null
  error: null,
  backend: '',
  variant: '',
  base: '',
};

let laya = null;

export function getState() {
  return { ...st, ready: !!laya };
}
export function isReady() {
  return !!laya;
}

function sset(message, progress = null) {
  st.message = message;
  st.progress = progress;
}

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(buf.length, buf.length || total);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onProgress?.(got, total);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Stitch the <= 24 MiB parts back together, reusing anything already in Cache Storage.
async function fetchParts(dir, entry, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE);
  } catch {
    /* private mode etc.: just download every time */
  }
  const out = new Uint8Array(entry.size);
  let off = 0;
  let fromCache = 0;
  for (const part of entry.parts) {
    const url = dir + part;
    let bytes = null;
    try {
      const hit = cache && (await cache.match(url));
      if (hit) {
        bytes = new Uint8Array(await hit.arrayBuffer());
        fromCache++;
      }
    } catch {
      /* ignore cache read errors */
    }
    if (!bytes) {
      bytes = await fetchBytes(url, (got) => onProgress(off + got, entry.size));
      try {
        if (cache) await cache.put(url, new Response(bytes));
      } catch {
        /* quota exceeded: keep going without caching */
      }
    }
    if (off + bytes.length > entry.size) throw new Error('weights are larger than the manifest says');
    out.set(bytes, off);
    off += bytes.length;
    onProgress(off, entry.size);
  }
  if (off !== entry.size) throw new Error(`weights incomplete: got ${off} of ${entry.size} bytes`);
  return { data: out, fromCache };
}

async function hasWebGPU() {
  try {
    return !!navigator.gpu && !!(await navigator.gpu.requestAdapter());
  } catch {
    return false;
  }
}

export async function load({ base = getBase(), variant = getVariant() } = {}) {
  if (st.status === 'loading') return getState();
  laya = null;
  st.status = 'loading';
  st.error = null;
  st.backend = '';
  st.variant = '';
  st.base = base;
  sset('Fetching model manifest…', 0);
  try {
    const manifest = await fetch(base + 'manifest.json').then((r) => {
      if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
      return r.json();
    });
    const v = manifest.variants?.[variant];
    if (!v) throw new Error(`variant "${variant}" not in manifest`);

    const noWebGPU = variant === 'q8e8';
    const gpu = await hasWebGPU();
    let backend = gpu && !noWebGPU ? 'webgpu' : 'wasm';

    ort.env.wasm.wasmPaths = new URL('./vendor/', import.meta.url).href;
    // WebGPU deliberately assigns a few shape/CPU-only ops off-device; those warnings are expected.
    ort.env.logLevel = 'error';
    ort.env.wasm.numThreads =
      typeof self !== 'undefined' && self.crossOriginIsolated
        ? Math.min(4, navigator.hardwareConcurrency || 2)
        : 1;

    sset('Loading tokenizer and config…', 0);
    const [tj, tc, cfg] = await Promise.all(
      ['tokenizer.json', 'tokenizer_config.json', 'rl_agent_config.json'].map((f) =>
        fetch(base + f).then((r) => {
          if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
          return r.json();
        })
      )
    );
    const tokenizer = new Tokenizer(tj, tc);

    sset('Downloading graph…', 0);
    const graph = await fetchBytes(base + v.onnx, (got, total) =>
      sset(`Downloading graph: ${(got / 1048576).toFixed(0)}${total ? ' / ' + (total / 1048576).toFixed(0) : ''} MB`, total ? got / total : null)
    );

    const { data, fromCache } = await fetchParts(base, v.data, (got, total) => {
      sset(`Downloading weights: ${(got / 1048576).toFixed(0)} / ${(total / 1048576).toFixed(0)} MB`, got / total);
    });

    sset('Creating inference session (first run can take a while)…', null);
    const session = await ort.InferenceSession.create(graph, {
      executionProviders: backend === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
      externalData: [{ path: v.data.name, data }],
    });

    laya = new Laya(ort, session, tokenizer, cfg);
    st.backend = backend;
    st.variant = variant;
    st.status = 'ready';

    sset('Warming up…', null);
    await laya.systemOne('warm up', { w: { type: 'noul', instructions: 'This is a warm-up call' } });

    const threads = ort.env.wasm.numThreads;
    sset(
      `Laya ready · ${backend === 'webgpu' ? 'WebGPU' : `WASM (${threads} thread${threads > 1 ? 's' : ''})`} · ${variant}` +
        (fromCache ? ` · ${fromCache} part(s) from cache` : ''),
      null
    );
    return getState();
  } catch (err) {
    st.status = 'error';
    st.error = err?.message || String(err);
    sset(`Could not load Laya: ${st.error}`, null);
    laya = null;
    return getState();
  }
}

// Rank candidate articles for a query with a single batched Laya call: one Choice question over
// the candidates plus a Noul question about whether the query is a meaningful topic. Returns null
// when the model is not loaded or there are too few candidates; the caller falls back to lexical.
export async function rank(query, candidates, { topK = 20 } = {}) {
  if (!laya || !candidates || candidates.length < 2) return null;
  const picks = candidates.slice(0, topK);
  // Use short numeric keys instead of the A#### ids: Laya's question head budgets ~192 tokens for
  // all options combined, so keeping the labels small leaves room for the full titles.
  const criteria = {};
  const keyToId = {};
  picks.forEach((a, i) => {
    const k = String(i + 1);
    criteria[k] = a.title;
    keyToId[k] = a.id;
  });
  const questions = {
    best: {
      type: 'choice',
      instructions:
        'Using only the candidate articles listed in the options, pick the single article that best matches the user\'s search query in the input.',
      criteria,
    },
    meaningful: {
      type: 'noul',
      instructions: 'The search query is a coherent, meaningful encyclopedia topic.',
      criteria: {
        true: 'A real topic someone could look up',
        false: 'Gibberish, empty, or meaningless input',
      },
    },
  };
  const res = await laya.systemOne(query, questions);
  const best = res.answers.best;
  const probabilities = {};
  for (const [k, p] of Object.entries(best?.probabilities || {})) {
    const id = keyToId[k];
    if (id) probabilities[id] = p;
  }
  return {
    probabilities,
    confidence: best?.confidence,
    meaningful: res.answers.meaningful?.noul,
    latencyMs: res.latency_ms,
  };
}
