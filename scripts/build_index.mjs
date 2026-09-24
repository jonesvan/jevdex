#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TARGET = 1000;
const CANDIDATES = 1150;
const BATCH = 20;
const CONCURRENCY = 4;
const SUMMARY_MAX = 600;

const USER_AGENT = 'jevdex/1.0 (https://github.com/jonesvan/jevdex)';

const NON_ARTICLE =
  /^(Main_Page|Special:|Wikipedia:|Portal:|Category:|File:|Talk:|Template:|Help:|User:|User_talk:|Draft:|Module:|MediaWiki:|Book:|TimedText:|Media:|Image:|wikt:)/;

const norm = (s) =>
  s.replace(/_/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase());

function isoDate(d) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

async function topTitlesForDate(date) {
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${date}`;
  const data = await fetchJson(url);
  const articles = data?.items?.[0]?.articles || [];
  return articles.map((a) => a.article).filter((t) => t && !NON_ARTICLE.test(t));
}

async function collectCandidates(baseDate) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < 20 && out.length < CANDIDATES; i++) {
    const d = new Date(baseDate);
    d.setUTCDate(d.getUTCDate() - i);
    let titles;
    try {
      titles = await topTitlesForDate(isoDate(d));
    } catch (err) {
      console.warn(`  ! ${isoDate(d)}: ${err.message}`);
      continue;
    }
    let added = 0;
    for (const t of titles) {
      const key = norm(t);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
      added++;
      if (out.length >= CANDIDATES) break;
    }
    console.log(`  ${isoDate(d)}: +${added} (total ${out.length})`);
  }
  return out;
}

async function enrichBatch(titles) {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    formatversion: '2',
    redirects: '1',
    prop: 'extracts|info',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    exlimit: '20',
    titles: titles.join('|'),
  });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return await fetchJson('https://en.wikipedia.org/w/api.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
    } catch (err) {
      if (attempt === 4) throw err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function buildPageMap(data) {
  const titleToPage = new Map();
  for (const p of data?.query?.pages || []) {
    if (p.missing || !p.extract || !p.extract.trim()) continue;
    titleToPage.set(norm(p.title), p);
  }
  const alias = new Map();
  for (const n of data?.query?.normalized || []) alias.set(norm(n.from), norm(n.to));
  for (const r of data?.query?.redirects || []) alias.set(norm(r.from), norm(r.to));
  const resolve = (t) => {
    let cur = norm(t);
    for (let i = 0; i < 6; i++) {
      const next = alias.get(cur);
      if (!next || next === cur) break;
      cur = next;
    }
    return cur;
  };
  return { titleToPage, resolve };
}

function cleanSummary(text) {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= SUMMARY_MAX) return s;
  const cut = s.slice(0, SUMMARY_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return (end > 200 ? cut.slice(0, end + 1) : cut).trim() + '…';
}

async function main() {
  const baseArg = process.argv[2];
  const baseDate = baseArg
    ? new Date(`${baseArg}T12:00:00Z`)
    : new Date(Date.now() - 3 * 86400000);

  console.log(`Collecting top-viewed articles around ${isoDate(baseDate)}…`);
  const candidates = await collectCandidates(baseDate);
  console.log(`Collected ${candidates.length} candidate titles.`);

  const batches = [];
  for (let i = 0; i < candidates.length; i += BATCH) {
    batches.push(candidates.slice(i, i + BATCH));
  }

  console.log(`Enriching via MediaWiki Action API (${batches.length} batches)…`);
  const results = [];
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const chunk = batches.slice(i, i + CONCURRENCY);
    const datas = await Promise.all(chunk.map((b) => enrichBatch(b)));
    for (let j = 0; j < chunk.length; j++) {
      const { titleToPage, resolve } = buildPageMap(datas[j]);
      for (const raw of chunk[j]) {
        const page = titleToPage.get(resolve(raw));
        if (!page) continue;
        const key = norm(page.title);
        if (results.some((r) => r.key === key)) continue;
        const url =
          page.fullurl ||
          page.canonicalurl ||
          `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`;
        results.push({ key, title: page.title, summary: cleanSummary(page.extract), url });
      }
    }
    process.stdout.write(
      `  ${Math.min((i + chunk.length) * BATCH, candidates.length)}/${candidates.length}\r`
    );
    if (results.length >= TARGET) break;
  }
  console.log('');

  const articles = results.slice(0, TARGET).map((r, i) => ({
    id: `A${String(i + 1).padStart(4, '0')}`,
    title: r.title,
    summary: r.summary,
    url: r.url,
  }));

  if (articles.length < TARGET) {
    console.warn(`Warning: only ${articles.length} articles (wanted ${TARGET}).`);
  }

  const generated = new Date().toISOString().slice(0, 10);
  const md = [];
  md.push('# JevDex Index');
  md.push('');
  md.push(
    `_${articles.length} most-viewed English Wikipedia articles (source: Wikimedia pageviews, ${isoDate(baseDate)}). Generated ${generated}._`
  );
  md.push('');
  articles.forEach((a, i) => {
    md.push(`## ${i + 1}. ${a.title}`);
    md.push('');
    md.push(`**Link:** ${a.url}`);
    md.push('');
    md.push(a.summary);
    md.push('');
  });

  await writeFile(join(ROOT, 'index.md'), md.join('\n'), 'utf8');
  await mkdir(join(ROOT, 'public'), { recursive: true });
  await writeFile(
    join(ROOT, 'public', 'index.json'),
    JSON.stringify({ generated, count: articles.length, articles }, null, 0),
    'utf8'
  );

  console.log(`Wrote index.md and public/index.json (${articles.length} articles).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
