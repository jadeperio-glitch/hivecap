import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // Test 1: shared horses visible to this user
  const { data: sharedData, count: sharedCount, error: sharedError } = await supabase
    .from("horses")
    .select("id, name, brain_layer", { count: "exact" })
    .eq("brain_layer", "shared")
    .limit(20);

  const sharedSample = (sharedData ?? []).slice(0, 10).map((h) => h.name);

  // Test 2: performance rows for Race 5
  const { data: perfData, error: perfError } = await supabase
    .from("performance")
    .select("horse_id, brain_layer, horses(name, brain_layer)")
    .eq("race_id", "792f0ae2-4c0d-4fb6-a458-df8c04f1f877");

  // Supabase may return nested relation as object or array — handle both
  const race5Names = (perfData ?? []).map((p) => {
    const h = p.horses;
    if (!h) return null;
    if (Array.isArray(h)) return h[0]?.name ?? null;
    return (h as { name: string }).name;
  }).filter((n): n is string => n !== null);

  const race5Layers = (perfData ?? []).map((p) => p.brain_layer);

  // Test 3: race row itself
  const { data: raceRow, error: raceError } = await supabase
    .from("races")
    .select("id, race_number, race_name, race_date")
    .eq("id", "792f0ae2-4c0d-4fb6-a458-df8c04f1f877")
    .maybeSingle();

  return NextResponse.json({
    user_id: user.id,
    shared_horses_count: sharedCount,
    shared_horses_error: sharedError?.message ?? null,
    shared_horses_sample: sharedSample,
    race5_perf_count: (perfData ?? []).length,
    race5_perf_error: perfError?.message ?? null,
    race5_horses: race5Names,
    race5_perf_layers: race5Layers,
    race5_row_found: raceRow !== null,
    race5_row_error: raceError?.message ?? null,
    race5_row_data: raceRow,
  });
}
