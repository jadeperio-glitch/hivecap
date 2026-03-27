/**
 * The Racing API — typed client wrapper
 * Server-side only. Never import this in client components.
 * Env vars: RACING_API_USERNAME, RACING_API_PASSWORD, RACING_API_BASE_URL
 */

const BASE_URL = (process.env.RACING_API_BASE_URL  ?? '').replace(/\/$/, '');
const USERNAME = process.env.RACING_API_USERNAME ?? '';
const PASSWORD = process.env.RACING_API_PASSWORD ?? '';

// The Racing API uses HTTP Basic Auth: base64(username:password)
function authHeader(): string {
  const encoded = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  return `Basic ${encoded}`;
}

// Throttle: only delay when calls are made in rapid succession.
// A single isolated call has zero added latency.
const MIN_CALL_INTERVAL_MS = 1000;
let lastCallAt = 0;

async function racingFetch<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  if (!BASE_URL || !USERNAME || !PASSWORD) {
    throw new Error(
      'RACING_API_BASE_URL, RACING_API_USERNAME, and RACING_API_PASSWORD must be set in .env.local',
    );
  }

  const elapsed = Date.now() - lastCallAt;
  if (lastCallAt > 0 && elapsed < MIN_CALL_INTERVAL_MS) {
    await new Promise<void>(r => setTimeout(r, MIN_CALL_INTERVAL_MS - elapsed));
  }
  lastCallAt = Date.now();

  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
    },
    // Cache each unique request for 60 s at the Next.js layer
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Racing API ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`,
    );
  }

  return res.json() as Promise<T>;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Runner {
  horse_id: string;
  horse: string;            // horse name
  number: string;           // cloth / saddlecloth number (API returns as string)
  position: string;         // finishing position, or "F" / "U" / "R" etc.
  draw: string;             // stall draw (empty string where N/A)
  btn: string;              // beaten distance from winner (empty string for winner)
  ovr_btn: string;          // overall beaten distance (empty string for winner)
  age: string;
  sex: string;              // "G" gelding, "M" mare, "C" colt, etc.
  weight: string;           // carried weight in stones-lbs e.g. "9-2"
  weight_lbs: string;       // carried weight in lbs (API returns as string)
  headgear: string;         // e.g. "b" blinkers, "v" visor, "" if none
  time: string;             // finishing time (winner only, "" for others)
  sp: string;               // starting price as fraction e.g. "5/1"
  sp_dec: string;           // starting price as decimal e.g. "6.00" (API returns as string)
  bsp: string;              // Betfair SP (empty string if unavailable)
  or: string;               // Official Rating ("–" if unavailable)
  rpr: string;              // Racing Post Rating ("–" if unavailable)
  tsr: string;              // Top Speed Rating ("–" if unavailable)
  prize: string;            // prize money earned (empty string if none)
  jockey: string;
  jockey_id: string;
  jockey_claim_lbs: string; // weight allowance claimed (API returns as string)
  trainer: string;
  trainer_id: string;
  owner: string;
  owner_id: string;
  sire: string;
  sire_id: string;
  dam: string;
  dam_id: string;
  damsire: string;
  damsire_id: string;
  comment: string;          // race-day comment / notes (empty string if none)
  silk_url: string;         // URL to jockey silk image (empty string if none)
}

export interface Race {
  race_id: string;
  date: string;             // YYYY-MM-DD
  region: string;           // e.g. "usa", "gb", "ire"
  course: string;           // course name
  course_id: string;
  off: string;              // scheduled off time e.g. "14:30"
  off_dt: string;           // ISO datetime of off time
  race_name: string;        // full race title
  type: string;             // "Flat" | "Hurdle" | "Chase" | "NH Flat" etc.
  class: string | null;     // race class / grade
  pattern: string | null;   // "Group 1" / "Listed" / "Grade 1" etc.
  rating_band: string | null; // e.g. "0-85"
  age_band: string | null;  // e.g. "3yo+"
  sex_rest: string | null;  // sex restriction e.g. "C&G"
  dist: string;             // distance in "Xm Xf" format
  dist_y: number;           // distance in yards
  dist_m: number;           // distance in metres
  dist_f: number;           // distance in furlongs (decimal)
  going: string;            // going description e.g. "Good to Firm"
  surface: string;          // "Turf" | "Dirt" | "Synthetic"
  jumps: string | null;     // hurdle / fence details (jumps races)
  runners: Runner[];
  non_runners: string;      // comma-separated non-runner names (empty string if none)
  winning_time_detail: string | null;
  comments: string | null;  // race-level stewards / race comments
  tote_win: string | null;
  tote_pl: string | null;
  tote_ex: string | null;
  tote_csf: string | null;
  tote_tricast: string | null;
  tote_trifecta: string | null;
}

export interface ResultsResponse {
  results: Race[];
  total: number;   // total results matching the query
  limit: number;   // page size
  skip: number;    // pagination offset
  query: Record<string, string>; // echo of the query params sent
}

export interface RacecardResponse {
  race: Race;
}

export interface UpcomingRacesResponse {
  races: Race[];
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Fetch race results for a given date (YYYY-MM-DD).
 * Defaults to region=usa. Pass region='' to fetch all regions.
 * Optionally filter by track/course name.
 */
export async function getResults(
  date: string,
  track?: string,
  region = 'usa',
): Promise<ResultsResponse> {
  const params: Record<string, string> = {
    start_date: date,
    end_date: date,
  };
  if (region) params.region = region;
  if (track) params.course = track;
  return racingFetch<ResultsResponse>('/v1/results', params);
}

/**
 * Fetch the full racecard (entries, weights, draw) for a specific race ID.
 */
export async function getRacecard(raceId: string): Promise<RacecardResponse> {
  return racingFetch<RacecardResponse>(`/v1/races/${encodeURIComponent(raceId)}`);
}

/**
 * Fetch today's upcoming races.
 * Optionally filter by track/course name.
 */
export async function getUpcomingRaces(
  track?: string,
): Promise<UpcomingRacesResponse> {
  const today = new Date().toISOString().split('T')[0];
  const params: Record<string, string> = { date: today };
  if (track) params.course = track;
  return racingFetch<UpcomingRacesResponse>('/v1/racecards', params);
}
