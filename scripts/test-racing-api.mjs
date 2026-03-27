/**
 * Quick smoke-test for The Racing API.
 * Run from project root: node scripts/test-racing-api.mjs
 *
 * Reads RACING_API_USERNAME, RACING_API_PASSWORD, and RACING_API_BASE_URL from .env.local directly —
 * no dev server needed.
 *
 * Region codes: usa | can | gb | ire | fr | hk
 * North America data requires the "North America Add-on" in your Racing API dashboard.
 */

import { readFileSync } from 'fs';

// ── Load .env.local ──────────────────────────────────────────────────────────
const env = {};
try {
  const raw = readFileSync('.env.local', 'utf-8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    env[key] = val;
  }
} catch {
  console.error('Could not read .env.local — make sure it exists at project root.');
  process.exit(1);
}

const BASE_URL  = (env.RACING_API_BASE_URL  ?? '').replace(/\/$/, '');
const USERNAME  = env.RACING_API_USERNAME  ?? '';
const PASSWORD  = env.RACING_API_PASSWORD  ?? '';

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error('RACING_API_BASE_URL, RACING_API_USERNAME, and RACING_API_PASSWORD must be set in .env.local');
  process.exit(1);
}

// ── Auth ─────────────────────────────────────────────────────────────────────
const encoded = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const headers = { Authorization: `Basic ${encoded}`, Accept: 'application/json' };

const today = new Date().toISOString().split('T')[0];
const yesterday = new Date(Date.now() - 864e5).toISOString().split('T')[0];

// ── Shared helpers ────────────────────────────────────────────────────────────

// Full dump — used for global baseline
async function fetchAndLog(url, label) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${label}`);
  console.log(`GET ${url}`);
  console.log('─'.repeat(60));

  const res = await fetch(url, { headers });
  console.log(`HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Error body:', body || '(empty)');
    return;
  }

  const data = await res.json();

  console.log('\nTop-level keys:', Object.keys(data));

  const firstArrayKey = Object.keys(data).find(k => Array.isArray(data[k]));

  if (firstArrayKey) {
    const arr = data[firstArrayKey];
    console.log(`\ndata.${firstArrayKey}: ${arr.length} item(s)`);
    if (arr.length > 0) {
      const first = arr[0];
      console.log('First item keys:', Object.keys(first));
      console.log('\nFirst item (full):');
      console.log(JSON.stringify(first, null, 2));

      if (Array.isArray(first.runners) && first.runners.length > 0) {
        console.log('\nFirst runner:');
        console.log(JSON.stringify(first.runners[0], null, 2));
      }
    } else {
      console.log(`No ${firstArrayKey} returned — try a different date.`);
    }
  } else {
    console.log('\nFull response:');
    console.log(JSON.stringify(data, null, 2));
  }
}

// Summary only — count + first item's course and region
async function fetchAndLogSummary(url, label) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${label}`);
  console.log(`GET ${url}`);
  console.log('─'.repeat(60));

  const res = await fetch(url, { headers });
  console.log(`HTTP ${res.status} ${res.statusText}`);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('Error body:', body || '(empty)');
    return;
  }

  const data = await res.json();
  const results = data.results ?? [];

  console.log(`Result count : ${results.length}`);
  if (results.length > 0) {
    console.log(`First course : ${results[0].course}`);
    console.log(`First region : ${results[0].region}`);
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Call 0: Global baseline (no region filter, today) ────────────────────────
await fetchAndLog(
  `${BASE_URL}/v1/results?start_date=${today}&end_date=${today}`,
  'Global results — no region filter, today',
);

await sleep(300);

// ── Call 1: region=us, today ──────────────────────────────────────────────────
await fetchAndLogSummary(
  `${BASE_URL}/v1/results?start_date=${today}&end_date=${today}&region=us`,
  `region=us, today (${today})`,
);

await sleep(300);

// ── Call 2: region=usa, yesterday ────────────────────────────────────────────
await fetchAndLogSummary(
  `${BASE_URL}/v1/results?start_date=${yesterday}&end_date=${yesterday}&region=usa`,
  `region=usa, yesterday (${yesterday})`,
);

await sleep(300);

// ── Call 3: region=us, yesterday ─────────────────────────────────────────────
await fetchAndLogSummary(
  `${BASE_URL}/v1/results?start_date=${yesterday}&end_date=${yesterday}&region=us`,
  `region=us, yesterday (${yesterday})`,
);
