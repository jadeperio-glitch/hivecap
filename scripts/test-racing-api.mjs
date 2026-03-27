/**
 * Quick smoke-test for The Racing API.
 * Run from project root: node scripts/test-racing-api.mjs
 *
 * Confirmed endpoint: /v1/north-america/meets (hyphen, not underscore)
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

const BASE_URL = (env.RACING_API_BASE_URL ?? '').replace(/\/$/, '');
const USERNAME = env.RACING_API_USERNAME ?? '';
const PASSWORD = env.RACING_API_PASSWORD ?? '';

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error('RACING_API_BASE_URL, RACING_API_USERNAME, and RACING_API_PASSWORD must be set in .env.local');
  process.exit(1);
}

const encoded = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
const headers = { Authorization: `Basic ${encoded}`, Accept: 'application/json' };

await new Promise(r => setTimeout(r, 1000));

const DATE = '2026-03-27';
const url = `${BASE_URL}/v1/north-america/meets?date=${DATE}`;

console.log(`\nGET ${url}\n`);

const res = await fetch(url, { headers });
console.log(`HTTP ${res.status} ${res.statusText}`);

const data = await res.json();
const meets = data.meets ?? [];

console.log(`\nMeet count : ${meets.length}`);
console.log();

meets.slice(0, 3).forEach((meet, i) => {
  console.log(`[${i + 1}] ${meet.track_name} (${meet.track_id}) | ${meet.date} | meet_id: ${meet.meet_id}`);
});
