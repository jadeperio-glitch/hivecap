import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function GET() {
  const supabase = await createClient();
  const authResult = await supabase.auth.getUser();
  const user = authResult.data.user;

  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const sharedResult = await supabase
    .from("horses")
    .select("id, name, brain_layer", { count: "exact" })
    .eq("brain_layer", "shared")
    .limit(20);

  const sharedSample = (sharedResult.data || []).slice(0, 10).map(function (h) {
    return h.name;
  });

  const race5Result = await supabase
    .from("performance")
    .select("horse_id, brain_layer, horses(name, brain_layer)")
    .eq("race_id", "792f0ae2-4c0d-4fb6-a458-df8c04f1f877");

  const race5Names = (race5Result.data || [])
    .map(function (p) { return p.horses ? p.horses.name : null; })
    .filter(function (n) { return n !== null; });

  const race5Layers = (race5Result.data || []).map(function (p) {
    return p.brain_layer;
  });

  const race5RowResult = await supabase
    .from("races")
    .select("id, race_number, race_name, race_date")
    .eq("id", "792f0ae2-4c0d-4fb6-a458-df8c04f1f877")
    .maybeSingle();

  return NextResponse.json({
    user_id: user.id,
    shared_horses_count: sharedResult.count,
    shared_horses_error: sharedResult.error ? sharedResult.error.message : null,
    shared_horses_sample: sharedSample,
    race5_perf_count: race5Result.data ? race5Result.data.length : 0,
    race5_perf_error: race5Result.error ? race5Result.error.message : null,
    race5_horses: race5Names,
    race5_perf_layers: race5Layers,
    race5_row_found: race5RowResult.data !== null,
    race5_row_error: race5RowResult.error ? race5RowResult.error.message : null,
    race5_row_data: race5RowResult.data,
  });
}
