import { createAdminClient } from "@/lib/supabase/admin";

export type RaceCoverageResult = {
  race_number: number;
  race_id: string | null;
  covered: boolean;
  reason: "fully_covered" | "race_not_found" | "not_marked_complete" | "insufficient_rows";
  performance_count?: number;
  expected_field_size?: number;
};

// Uses the admin (service-role) client so RLS on `performance` doesn't hide
// other users' rows — coverage is a global check, not per-user.
export async function checkRaceCoverage(params: {
  track_id: string;
  race_date: string; // ISO yyyy-mm-dd
  race_numbers: number[];
}): Promise<RaceCoverageResult[]> {
  const admin = createAdminClient();

  // Batch fetch all race rows for this track+date in one query.
  const { data: raceRows } = await admin
    .from("races")
    .select("id, race_number, coverage_complete, expected_field_size")
    .eq("track_id", params.track_id)
    .eq("race_date", params.race_date)
    .in("race_number", params.race_numbers);

  const raceMap = new Map<number, { id: string; coverage_complete: boolean; expected_field_size: number | null }>();
  for (const row of raceRows ?? []) {
    raceMap.set(row.race_number, {
      id: row.id,
      coverage_complete: row.coverage_complete,
      expected_field_size: row.expected_field_size,
    });
  }

  // Collect race_ids that are marked complete — only those need a perf count.
  const markedRaceIds: string[] = [];
  for (const raceNumber of params.race_numbers) {
    const row = raceMap.get(raceNumber);
    if (row?.coverage_complete) markedRaceIds.push(row.id);
  }

  // Batch fetch performance counts for marked races.
  const perfCounts = new Map<string, number>();
  if (markedRaceIds.length > 0) {
    const { data: perfs } = await admin
      .from("performance")
      .select("race_id")
      .in("race_id", markedRaceIds)
      .eq("brain_layer", "shared");

    for (const p of perfs ?? []) {
      perfCounts.set(p.race_id, (perfCounts.get(p.race_id) ?? 0) + 1);
    }
  }

  // Build one result per requested race_number.
  return params.race_numbers.map((raceNumber) => {
    const row = raceMap.get(raceNumber);

    if (!row) {
      return { race_number: raceNumber, race_id: null, covered: false, reason: "race_not_found" };
    }

    if (!row.coverage_complete) {
      return { race_number: raceNumber, race_id: row.id, covered: false, reason: "not_marked_complete" };
    }

    const count = perfCounts.get(row.id) ?? 0;
    const expected = row.expected_field_size ?? 0;

    if (count >= expected && expected > 0) {
      return {
        race_number: raceNumber,
        race_id: row.id,
        covered: true,
        reason: "fully_covered",
        performance_count: count,
        expected_field_size: expected,
      };
    }

    return {
      race_number: raceNumber,
      race_id: row.id,
      covered: false,
      reason: "insufficient_rows",
      performance_count: count,
      expected_field_size: expected,
    };
  });
}
