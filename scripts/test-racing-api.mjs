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

// ── 1 second delay to avoid rate limiting from any previous requests ─────────
await new Promise(r => setTimeout(r, 1000));

// ── North America meets: today 2026-03-27 ────────────────────────────────────
const DATE = '2026-03-27';
const url = `${BASE_URL}/v1/north_america/meets?date=${DATE}`;

console.log(`\nGET ${url}\n`);

const res = await fetch(url, { headers });
console.log(`HTTP ${res.status} ${res.statusText}`);

if (!res.ok) {
  const body = await res.text().catch(() => '');
  console.error('Error body:', body || '(empty)');
  process.exit(1);
}

const data = await res.json();
const meets = data.meets ?? data;

console.log(`\nTop-level keys : ${Object.keys(data).join(', ')}`);
console.log(`Meet count     : ${Array.isArray(meets) ? meets.length : '(not an array)'}`);
console.log();

if (Array.isArray(meets) && meets.length > 0) {
  console.log('First meet (full object):');
  console.log(JSON.stringify(meets[0], null, 2));
} else {
  console.log('Full response:');
  console.log(JSON.stringify(data, null, 2));
}
