const DEFAULT_URL = 'https://api.defapi.org/v1/systemone';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const BLOCK_SIZE = 200;
const TOP_K = 12;
const STATE_SUMMARY_CHARS = 80;
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
    key: localStorage.getItem(KEY_STORAGE) || '',
    url: localStorage.getItem(URL_STORAGE) || DEFAULT_URL,
    model: localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL,
  };
}

function reflectConfig() {
  const c = cfg();
  const has = Boolean(c.key);
  $('#key-banner').classList.toggle('hidden', has);
  $('#key-state').textContent = has ? 'A key is saved in this browser.' : 'No key saved yet.';
  $('#api-key').value = c.key;
  $('#api-url').value = c.url;
  $('#api-model').value = c.model;
}

async function loadIndex() {
  const res = await fetch('index.json', { cache: 'no-store' });
  if (!res.ok) throw new Error(`index.json: HTTP ${res.status}`);
  const data = await res.json();
  INDEX = data.articles || [];
  META = { generated: data.generated, count: data.count || INDEX.length };
  $('#status').textContent = `${INDEX.length} articles in the index · ${META.generated || ''} · model ${cfg().model}`;
}

function buildRequest(query, model) {
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

function rankAnswers(payload) {
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

function setBusy(state) {
  busy = state;
  $('#search-btn').disabled = state;
  $('#search-btn').textContent = state ? 'Searching…' : 'Search';
}

async function search(query) {
  if (busy || !query) return;
  const { key, url, model } = cfg();
  if (!key) {
    $('#key-banner').classList.remove('hidden');
    $('#settings').open = true;
    $('#status').textContent = 'Add your API key in Settings to enable Jev ranking.';
    return;
  }

  setBusy(true);
  $('#status').textContent = `Sending ${INDEX.length} articles to Jev…`;
  $('#empty').classList.add('hidden');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(buildRequest(query, model)),
    });
    const payload = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = payload?.message || payload?.error || payload?.detail?.message || `HTTP ${res.status}`;
      throw new Error(msg);
    }

    const meaningful = payload?.answers?.query_meaningful?.noul;
    let note = undefined;
    if (typeof meaningful === 'number' && meaningful < 0.5) {
      note = `Jev thinks “${query}” is not a clear topic (${Math.round(meaningful * 100)}% meaningful). Showing best guesses.`;
    }
    renderCards(query, rankAnswers(payload), note);
  } catch (err) {
    console.warn('Jev call failed, falling back to lexical search:', err);
    renderCards(
      query,
      lexicalSearch(query),
      `Jev API unavailable (${err.message}). Showing lexical matches.`
    );
  } finally {
    setBusy(false);
  }
}

function init() {
  reflectConfig();

  $('#save-config').addEventListener('click', () => {
    store(KEY_STORAGE, $('#api-key').value.trim());
    store(URL_STORAGE, $('#api-url').value.trim());
    store(MODEL_STORAGE, $('#api-model').value.trim());
    reflectConfig();
    $('#status').textContent = cfg().key ? 'Settings saved.' : 'API key cleared.';
  });

  $('#clear-key').addEventListener('click', () => {
    store(KEY_STORAGE, '');
    reflectConfig();
    $('#status').textContent = 'API key cleared.';
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
