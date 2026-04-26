import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function getAdminIds(): string[] {
  return (process.env.HIVECAP_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function getAuthenticatedAdmin() {
  const supabase = createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  if (!getAdminIds().includes(user.id)) return null;
  return user;
}

// POST — mark a race as coverage-complete
// Body: { track_id, race_date, race_number, expected_field_size }
export async function POST(request: Request) {
  const user = await getAuthenticatedAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { track_id?: string; race_date?: string; race_number?: number; expected_field_size?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { track_id, race_date, race_number, expected_field_size } = body;
  if (!track_id || !race_date || !race_number || !expected_field_size) {
    return NextResponse.json({ error: "Missing required fields: track_id, race_date, race_number, expected_field_size" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Find or create the race row.
  const { data: existing } = await admin
    .from("races")
    .select("id")
    .eq("track_id", track_id)
    .eq("race_date", race_date)
    .eq("race_number", race_number)
    .maybeSingle();

  let raceId: string;

  if (existing) {
    raceId = existing.id;
    const { error: updateErr } = await admin
      .from("races")
      .update({
        expected_field_size,
        coverage_complete: true,
        coverage_marked_by: user.id,
        coverage_marked_at: new Date().toISOString(),
      })
      .eq("id", raceId);

    if (updateErr) {
      console.error("[admin/coverage POST] update error:", updateErr);
      return NextResponse.json({ error: "Failed to update race" }, { status: 500 });
    }
  } else {
    const { data: newRace, error: insertErr } = await admin
      .from("races")
      .insert({
        track_id,
        race_date,
        race_number,
        expected_field_size,
        coverage_complete: true,
        coverage_marked_by: user.id,
        coverage_marked_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertErr || !newRace) {
      console.error("[admin/coverage POST] insert error:", insertErr);
      return NextResponse.json({ error: "Failed to create race" }, { status: 500 });
    }
    raceId = newRace.id;
  }

  // Count existing shared performance rows.
  const { count: perfCount } = await admin
    .from("performance")
    .select("id", { count: "exact", head: true })
    .eq("race_id", raceId)
    .eq("brain_layer", "shared");

  const pc = perfCount ?? 0;

  return NextResponse.json({
    race_id: raceId,
    performance_count: pc,
    expected_field_size,
    fully_covered: pc >= expected_field_size,
  });
}

// GET — list all coverage-complete races with performance counts
export async function GET() {
  const user = await getAuthenticatedAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const admin = createAdminClient();

  const { data: races, error } = await admin
    .from("races")
    .select("id, race_date, race_number, expected_field_size, coverage_marked_at, track_id, tracks(name)")
    .eq("coverage_complete", true)
    .order("race_date", { ascending: false })
    .order("race_number", { ascending: true });

  if (error) {
    console.error("[admin/coverage GET] query error:", error);
    return NextResponse.json({ error: "Failed to fetch races" }, { status: 500 });
  }

  const raceIds = (races ?? []).map((r) => r.id);
  const perfCounts: Record<string, number> = {};

  if (raceIds.length > 0) {
    const { data: perfs } = await admin
      .from("performance")
      .select("race_id")
      .in("race_id", raceIds)
      .eq("brain_layer", "shared");

    for (const p of perfs ?? []) {
      perfCounts[p.race_id] = (perfCounts[p.race_id] ?? 0) + 1;
    }
  }

  const result = (races ?? []).map((r) => {
    const pc = perfCounts[r.id] ?? 0;
    const expected = r.expected_field_size ?? 0;
    return {
      race_id: r.id,
      track_name: (r.tracks as { name: string } | null)?.name ?? "Unknown",
      race_date: r.race_date,
      race_number: r.race_number,
      expected_field_size: expected,
      performance_count: pc,
      fully_covered: pc >= expected && expected > 0,
      coverage_marked_at: r.coverage_marked_at,
    };
  });

  return NextResponse.json(result);
}

// DELETE — unmark coverage (sets coverage_complete = false)
// Body: { race_id }
export async function DELETE(request: Request) {
  const user = await getAuthenticatedAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { race_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { race_id } = body;
  if (!race_id) {
    return NextResponse.json({ error: "Missing race_id" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { error } = await admin
    .from("races")
    .update({
      coverage_complete: false,
      coverage_marked_by: null,
      coverage_marked_at: null,
    })
    .eq("id", race_id);

  if (error) {
    console.error("[admin/coverage DELETE] error:", error);
    return NextResponse.json({ error: "Failed to unmark coverage" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
