/**
 * The Racing API — typed client wrapper
 * Server-side only. Never import this in client components.
 * Env vars: RACING_API_KEY, RACING_API_BASE_URL
 */

const BASE_URL = (process.env.RACING_API_BASE_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.RACING_API_KEY ?? '';

// The Racing API uses HTTP Basic Auth: key as username, empty password
function authHeader(): string {
  const encoded = Buffer.from(`${API_KEY}:`).toString('base64');
  return `Basic ${encoded}`;
}

async function racingFetch<T>(
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  if (!BASE_URL || !API_KEY) {
    throw new Error(
      'RACING_API_BASE_URL and RACING_API_KEY must be set in .env.local',
    );
  }

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
  horse: string;          // horse name
  jockey: string;
  trainer: string;
  number: number;         // cloth/saddlecloth number
  draw?: number;          // stall draw
  age?: string;
  weight?: string;        // carried weight e.g. "9-2"
  sp?: string;            // starting price e.g. "5/1"
  position?: string | number; // finishing position or "F", "U", etc.
  official_position?: string;
}

export interface Race {
  race_id: string;
  course: string;
  date: string;           // YYYY-MM-DD
  off_time: string;       // scheduled off time e.g. "14:30"
  name: string;           // race title
  distance: string;       // e.g. "1m 2f"
  going?: string;         // going description e.g. "Good to Firm"
  class?: string;         // race class / grade
  prize?: string;         // total prize fund
  runners: Runner[];
}

export interface ResultsResponse {
  results: Race[];
  total?: number;
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
 * Optionally filter by track/course name.
 */
export async function getResults(
  date: string,
  track?: string,
): Promise<ResultsResponse> {
  const params: Record<string, string> = {
    start_date: date,
    end_date: date,
  };
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
