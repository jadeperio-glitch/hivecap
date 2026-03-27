/**
 * Quick smoke-test for The Racing API.
 * Run from project root: node scripts/test-racing-api.mjs
 *
 * Reads RACING_API_USERNAME, RACING_API_PASSWORD, and RACING_API_BASE_URL from .env.local directly —
 * no dev server needed.
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

// ── Fetch today's results ────────────────────────────────────────────────────
const today = new Date().toISOString().split('T')[0];
const url = `${BASE_URL}/v1/results?start_date=${today}&end_date=${today}`;

console.log(`\nFetching: GET ${url}\n`);

const res = await fetch(url, { headers });

console.log(`HTTP ${res.status} ${res.statusText}`);
console.log('Content-Type:', res.headers.get('content-type'));

if (!res.ok) {
  const body = await res.text();
  console.error('\nError body:', body);
  process.exit(1);
}

const data = await res.json();

// ── Log response shape ───────────────────────────────────────────────────────
console.log('\n── Top-level keys ──────────────────────────────────────────────');
console.log(Object.keys(data));

const firstArrayKey = Object.keys(data).find(k => Array.isArray(data[k]));

if (firstArrayKey) {
  const arr = data[firstArrayKey];
  console.log(`\n── data.${firstArrayKey} (${arr.length} item(s)) ─────────────────────────────`);
  if (arr.length > 0) {
    const first = arr[0];
    console.log('\nFirst item keys:', Object.keys(first));
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
