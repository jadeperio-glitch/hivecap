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

// ── Shared fetch-and-log helper ───────────────────────────────────────────────
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
      console.log(`No ${firstArrayKey} returned for ${today} — try a past date with results.`);
    }
  } else {
    console.log('\nFull response:');
    console.log(JSON.stringify(data, null, 2));
  }
}

// ── Call 1: Global results (no region filter) ─────────────────────────────────
await fetchAndLog(
  `${BASE_URL}/v1/results?start_date=${today}&end_date=${today}`,
  'Global results (no region filter)',
);

// ── Call 2: North America results (region=usa) ────────────────────────────────
// The Racing API region codes: usa | can | gb | ire | fr | hk
// Note: the correct value is "usa", not "us".
// For Canadian tracks use region=can instead.
await fetchAndLog(
  `${BASE_URL}/v1/results?start_date=${today}&end_date=${today}&region=usa`,
  'North America results (region=usa)',
);
