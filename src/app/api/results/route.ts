/**
 * /api/results — proxy for The Racing API
 *
 * Keeps RACING_API_KEY server-side only.
 *
 * Query params:
 *   action  = "results" | "racecard" | "upcoming"  (default: "results")
 *   date    = YYYY-MM-DD                            (default: today)
 *   track   = course name filter                    (optional)
 *   raceId  = required when action=racecard
 */

import { getResults, getRacecard, getUpcomingRaces } from '@/lib/racing-api';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get('action') ?? 'results';
  const today = new Date().toISOString().split('T')[0];
  const date = searchParams.get('date') ?? today;
  const track = searchParams.get('track') ?? undefined;
  const raceId = searchParams.get('raceId');

  try {
    let data: unknown;

    if (action === 'racecard') {
      if (!raceId) {
        return Response.json({ error: 'raceId param is required for action=racecard' }, { status: 400 });
      }
      data = await getRacecard(raceId);

    } else if (action === 'upcoming') {
      data = await getUpcomingRaces(track);

    } else {
      // Default: results
      data = await getResults(date, track);

      // Log response shape on first call so we can verify the API contract.
      // Safe to leave in — logs only on the server, never sent to the client.
      console.log('[Racing API] getResults response shape:', JSON.stringify(
        summariseShape(data),
        null,
        2,
      ));
    }

    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Racing API] error:', message);
    return Response.json({ error: message }, { status: 502 });
  }
}

/**
 * Returns a lightweight "shape" summary of any value for logging:
 * replaces array contents with [{...}×N], truncates long strings.
 */
function summariseShape(value: unknown, depth = 0): unknown {
  if (depth > 3) return typeof value;
  if (Array.isArray(value)) {
    return value.length === 0
      ? []
      : [`/* ${value.length} item(s) */ ${JSON.stringify(summariseShape(value[0], depth + 1))}`];
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        summariseShape(v, depth + 1),
      ]),
    );
  }
  if (typeof value === 'string' && value.length > 60) {
    return value.slice(0, 60) + '…';
  }
  return value;
}
