import * as laya from './laya.js';

const DEFAULT_URL = 'https://api.defapi.org/v1/systemone';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const BLOCK_SIZE = 200;
const TOP_K = 12;
const LAYA_CANDIDATES = 20;
const STATE_SUMMARY_CHARS = 80;
const ENGINE_STORAGE = 'jevdex.engine';
const KEY_STORAGE = 'jevdex.apiKey';
const URL_STORAGE = 'jevdex.apiUrl';
const MODEL_STORAGE = 'jevdex.model';

const $ = (sel) => document.querySelector(sel);

let INDEX = [];
let META = {};
let busy = false;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n).trimEnd() + '…';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function store(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

function cfg() {
  return {
    engine: localStorage.getItem(ENGINE_STORAGE) || 'laya',
    key: localStorage.getItem(KEY_STORAGE) || '',
    url: localStorage.getItem(URL_STORAGE) || DEFAULT_URL,
    model: localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL,
  };
}

function setLayaProgress(f) {
  const el = $('#laya-progress');
  if (!el) return;
  if (f == null) {
    el.style.display = 'none';
    el.style.width = '0%';
  } else {
    el.style.display = 'block';
    el.style.width = (Math.max(0, Math.min(1, f)) * 100).toFixed(1) + '%';
  }
}

function reflectLaya() {
  const s = laya.getState();
  $('#laya-base').value = laya.getBase();
  $('#laya-variant').value = laya.getVariant();
  const note = $('#laya-status');
  if (s.error) note.textContent = `Error: ${s.error}`;
  else if (s.status === 'ready') note.textContent = s.message;
  else if (s.status === 'loading') note.textContent = 'Loading…';
  else note.textContent = 'Not loaded. Loading downloads the weights from Hugging Face once (cached afterwards).';
  $('#laya-load').textContent = s.status === 'loading' ? 'Loading…' : 'Load Laya model';
  $('#laya-load').disabled = s.status === 'loading';
}

function reflectConfig() {
  const c = cfg();
  $('#engine').value = c.engine;
  const jev = c.engine === 'jev';
  $('#jev-fields').classList.toggle('hidden', !jev);
  $('#laya-fields').classList.toggle('hidden', jev);
  const has = Boolean(c.key);
  $('#key-state').textContent = has ? 'A Jev key is saved in this browser.' : 'No Jev key saved.';
  $('#api-key').value = c.key;
  $('#api-url').value = c.url;
  $('#api-model').value = c.model;
  reflectLaya();
}

async function loadIndex() {
  const res = await fetch('index.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const data = await res.json();
  INDEX = data.articles || [];
  META = { generated: data.generated, count: data.count || INDEX.length };
  $('#status').textContent = `${INDEX.length} articles in the index · ${META.generated || ''}`;
}

function lexicalSearch(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = INDEX.map((a) => {
    const hay = `${a.title} ${a.summary}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const inTitle = a.title.toLowerCase().includes(t) ? 1 : 0;
      const inText = hay.includes(t) ? 1 : 0;
      score += inTitle * 3 + inText;
    }
    return [a.id, terms.length ? score / (terms.length * 4) : 0];
  });
  return scored.filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
}

function renderCards(query, ranked, note) {
  const byId = new Map(INDEX.map((a) => [a.id, a]));
  const results = $('#results');
  const empty = $('#empty');
  results.innerHTML = '';

  const items = ranked
    .map(([id, score]) => ({ article: byId.get(id), score }))
    .filter((x) => x.article)
    .slice(0, TOP_K);

  if (!items.length) {
    empty.classList.remove('hidden');
    empty.textContent = `No matches for “${query}”.`;
    $('#status').textContent = note || `0 results for “${query}”.`;
    return;
  }

  empty.classList.add('hidden');

  for (const { article, score } of items) {
    const pct = Math.round(score * 100);
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <h3><a href="${escapeHtml(article.url)}" target="_blank" rel="noopener">${escapeHtml(article.title)}</a></h3>
      <p>${escapeHtml(article.summary)}</p>
      <div class="card-meta">
        <span class="badge${pct < 10 ? ' low' : ''}">${pct}% match</span>
        <a href="${escapeHtml(article.url)}" target="_blank" rel="noopener">Wikipedia ↗</a>
      </div>`;
    results.appendChild(card);
  }

  $('#status').textContent = note || `${items.length} results for “${query}”.`;
}

function setBusy(state) {
  busy = state;
  $('#search-btn').disabled = state;
  $('#search-btn').textContent = state ? 'Searching…' : 'Search';
}

async function ensureLaya() {
  const s0 = laya.getState();
  if (s0.ready && s0.base === laya.getBase() && s0.variant === laya.getVariant()) return true;
  reflectLaya();
  const timer = setInterval(() => {
    const s = laya.getState();
    $('#status').textContent = s.message || 'Loading Laya…';
    setLayaProgress(s.progress);
  }, 150);
  try {
    const res = await laya.load({});
    return res.ready;
  } finally {
    clearInterval(timer);
    setLayaProgress(null);
    reflectLaya();
  }
}

async function searchWithLaya(query) {
  const lex = lexicalSearch(query);
  if (lex.length < 2) {
    renderCards(query, lex, `Only ${lex.length} lexical match(es) for “${query}”.`);
    return;
  }

  if (!(await ensureLaya())) {
    renderCards(query, lex, `Laya unavailable (${laya.getState().error || 'not loaded'}). Showing lexical matches.`);
    return;
  }

  const byId = new Map(INDEX.map((a) => [a.id, a]));
  const candidates = lex
    .map(([id]) => byId.get(id))
    .filter(Boolean)
    .slice(0, LAYA_CANDIDATES);

  $('#status').textContent = `Asking Laya about ${candidates.length} candidates…`;
  const result = await laya.rank(query, candidates, { topK: LAYA_CANDIDATES });
  if (!result) {
    renderCards(query, lex, 'Laya returned no answer. Showing lexical matches.');
    return;
  }

  const scored = candidates.map((a) => [a.id, result.probabilities[a.id] || 0]);
  scored.sort((a, b) => b[1] - a[1]);
  const inCandidates = new Set(scored.map(([id]) => id));
  const rest = lex.filter(([id]) => !inCandidates.has(id));
  const ranked = scored.concat(rest);

  let note;
  if (typeof result.meaningful === 'number' && result.meaningful < 0.5) {
    note = `Laya isn't sure “${query}” is a clear topic (${Math.round(result.meaningful * 100)}% meaningful). Best guesses.`;
  }
  renderCards(query, ranked, note);
}

function buildJevRequest(query, model) {
  const articles = INDEX.map((a) => ({
    id: a.id,
    title: a.title,
    summary: truncate(a.summary, STATE_SUMMARY_CHARS),
  }));

  const questions = {
    query_meaningful: {
      type: 'noul',
      instructions: {
        query,
        question: 'Is `query` a coherent, meaningful encyclopedia search topic?',
      },
      criteria: {
        true: 'A real topic someone could look up',
        false: 'Gibberish, empty, or meaningless input',
      },
    },
  };

  chunk(articles, BLOCK_SIZE).forEach((block, i) => {
    questions[`block_${i}`] = {
      type: 'choice',
      instructions: {
        query,
        question:
          'Using the candidate articles in `criteria` and the contexts in `articles`, which single article is most relevant to the search query `query`? Answer with its id.',
      },
      criteria: Object.fromEntries(block.map((a) => [a.id, a.title])),
    };
  });

  return { state: { query, articles }, model, questions };
}

function rankJevAnswers(payload) {
  const answers = payload?.answers || {};
  const scores = new Map();
  for (const [qid, ans] of Object.entries(answers)) {
    if (!qid.startsWith('block_') || ans?.type !== 'choice') continue;
    for (const [id, p] of Object.entries(ans.probabilities || {})) {
      const prev = scores.get(id) || 0;
      if (p > prev) scores.set(id, p);
    }
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

async function searchWithJev(query) {
  const { key, url, model } = cfg();
  if (!key) {
    $('#key-banner').classList.remove('hidden');
    $('#settings').open = true;
    $('#status').textContent = 'Add your Jev API key in Settings to enable remote ranking.';
    return;
  }

  $('#status').textContent = `Sending ${INDEX.length} articles to Jev…`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(buildJevRequest(query, model)),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = payload?.message || payload?.error || payload?.detail?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }

  const meaningful = payload?.answers?.query_meaningful?.noul;
  let note;
  if (typeof meaningful === 'number' && meaningful < 0.5) {
    note = `Jev thinks “${query}” is not a clear topic (${Math.round(meaningful * 100)}% meaningful). Showing best guesses.`;
  }
  renderCards(query, rankJevAnswers(payload), note);
}

async function search(query) {
  if (busy || !query) return;
  const { engine } = cfg();
  setBusy(true);
  $('#empty').classList.add('hidden');
  try {
    if (engine === 'jev') await searchWithJev(query);
    else await searchWithLaya(query);
  } catch (err) {
    console.warn('Decision engine failed, falling back to lexical search:', err);
    renderCards(query, lexicalSearch(query), `Decision engine unavailable (${err.message}). Showing lexical matches.`);
  } finally {
    setBusy(false);
  }
}

function init() {
  reflectConfig();

  $('#save-config').addEventListener('click', () => {
    store(ENGINE_STORAGE, $('#engine').value);
    store(KEY_STORAGE, $('#api-key').value.trim());
    store(URL_STORAGE, $('#api-url').value.trim());
    store(MODEL_STORAGE, $('#api-model').value.trim());
    laya.setBase($('#laya-base').value.trim());
    laya.setVariant($('#laya-variant').value.trim());
    reflectConfig();
    $('#status').textContent = 'Settings saved.';
  });

  $('#clear-key').addEventListener('click', () => {
    store(KEY_STORAGE, '');
    reflectConfig();
    $('#status').textContent = 'Jev API key cleared.';
  });

  $('#laya-load').addEventListener('click', async () => {
    laya.setBase($('#laya-base').value.trim());
    laya.setVariant($('#laya-variant').value.trim());
    if (laya.isReady()) {
      // force a clean reload if the base/variant changed
      const s = laya.getState();
      if (s.base === laya.getBase() && s.variant === laya.getVariant()) {
        reflectLaya();
        return;
      }
    }
    await ensureLaya();
  });

  $('#engine').addEventListener('change', () => {
    store(ENGINE_STORAGE, $('#engine').value);
    reflectConfig();
  });

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    search($('#query').value.trim());
  });

  loadIndex().catch((err) => {
    $('#status').textContent = `Could not load index.json (${err.message}).`;
  });
}

init();
