import { getNorthAmericaMeets, getNorthAmericaEntries, getUpcomingRaces } from "@/lib/racing-api";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET /api/racing/entries/diagnostic ────────────────────────────────────────
// Diagnostic only — no DB writes. Returns raw NA entries response so we can
// inspect field names before building the schema mapper.
//
// Query params:
//   date  — YYYY-MM-DD (defaults to 2026-04-04, Wood Memorial day)
//   track — case-insensitive substring match on track_name (defaults to "Aqueduct")
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") ?? "2026-04-04";
  const trackFilter = (searchParams.get("track") ?? "Aqueduct").toLowerCase();

  try {
    // Step 1: fetch NA meets for the requested date
    console.log("[diagnostic] fetching NA meets for date:", date);
    const meetsResponse = await getNorthAmericaMeets(date);

    const meets = meetsResponse.meets ?? [];
    console.log("[diagnostic] meets returned:", meets.length);

    if (meets.length === 0) {
      return json({
        error: "No NA meets found for this date",
        date,
        raw_meets_response: meetsResponse,
      });
    }

    // Step 2: find the target meet by track name substring
    const targetMeet = meets.find((m) =>
      m.track_name.toLowerCase().includes(trackFilter)
    );

    if (!targetMeet) {
      return json({
        error: `No meet found matching track filter "${trackFilter}"`,
        date,
        available_meets: meets.map((m) => ({
          meet_id: m.meet_id,
          track_name: m.track_name,
          country: m.country,
        })),
        raw_meets_response: meetsResponse,
      });
    }

    console.log("[diagnostic] target meet:", targetMeet.meet_id, targetMeet.track_name);

    // Step 3: try Path B — NA entries endpoint
    let pathUsed: "B" | "A" = "B";
    let data: unknown = null;
    let pathBError: string | null = null;

    try {
      data = await getNorthAmericaEntries(targetMeet.meet_id);
      console.log("[diagnostic] Path B succeeded");
    } catch (err) {
      const e = err as Error;
      pathBError = e.message;
      console.warn("[diagnostic] Path B failed:", e.message, "— falling back to Path A");

      // Path A fallback — /v1/racecards?course=<track>
      pathUsed = "A";
      data = await getUpcomingRaces(targetMeet.track_name);
      console.log("[diagnostic] Path A succeeded");
    }

    return json({
      diagnostic: true,
      date,
      path_used: pathUsed,
      ...(pathBError ? { path_b_error: pathBError } : {}),
      meet: {
        meet_id: targetMeet.meet_id,
        track_name: targetMeet.track_name,
        country: targetMeet.country,
      },
      data,
    });
  } catch (err) {
    const e = err as Error;
    console.error("[diagnostic] error:", e.message);
    return json({ error: e.message, stack: e.stack }, 500);
  }
}
