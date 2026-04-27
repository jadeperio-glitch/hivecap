import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BASE_PROMPT = `You are the HiveCap Brain — an expert horse racing analyst with deep knowledge of handicapping, wagering strategy, and the thoroughbred industry.

**Knowledge hierarchy — trust from highest to lowest:**
1. Brain Knowledge Base (extracted from official past performance documents) — treat as ground truth
2. Community Intelligence (verified posts from HiveCap users) — treat as analyst notes
3. Web search results — use to fill gaps, verify, or extend Brain data
4. Your own training knowledge — always your foundation; apply when no other source covers the question

**Behavior rules:**
- Never say "I don't have that information" or "I can't find that" before using web_search to look it up. Search first, then answer.
- When Brain data and web search results conflict, surface both and flag the discrepancy: state which source you trust more and why.
- When Brain data is present, lead with it. Supplement with web search for current conditions, recent workouts, scratches, or anything the Brain doesn't cover.
- When Brain data is absent, answer from your expertise and web search. Never refuse a racing question solely because no Brain data was uploaded.
- You specialize in: Beyer Speed Figures and pace analysis, pedigree research and trip notes, wagering strategy (exactas, trifectas, Pick 4/5/6), the 2026 Kentucky Derby field and contenders, track bias, trainer patterns, and jockey statistics.
- You never reproduce copyrighted content verbatim — always analyze, summarize, and provide original insights.
- You are precise, confident, and data-driven. When discussing horses, lead with the most analytically relevant factors.`;

const RACE_HALLUCINATION_GATE =
  `--- RACE REFERENCE DETECTED — NO BRAIN DATA ---\n` +
  `The user is asking about a specific race. The Brain has no extracted data for this race. ` +
  `You MUST state this clearly at the start of your response. Do not present any horse names, ` +
  `figures, or analysis as Brain Knowledge Base data. Web search is permitted and encouraged; ` +
  `clearly label all web-sourced information as such.`;

// UI state messages injected by the ingestion pipeline — never pass to Claude.
const UI_STATE_PATTERNS = [
  /^I (?:found|see) \d+/i,
  /^Brain updated/i,
  /^Got it/i,
  /Select a race to extract/i,
  /^We couldn't process/i,
  /^Extraction incomplete/i,
];

function isUiStateMessage(content: string): boolean {
  return UI_STATE_PATTERNS.some((p) => p.test(content.trimStart()));
}

export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// Detect patterns like "race 5", "race 5 at Churchill", "race 5 on May 2",
// "Churchill on May 2". Returns null when no usable race anchor is found.
// ─────────────────────────────────────────────────────────────────────────────
type RaceRef = {
  raceNumber: number | null;
  trackHint: string | null;
  dateHint: string | null; // ISO YYYY-MM-DD
};

function extractRaceReference(query: string): RaceRef | null {
  const lower = query.toLowerCase();

  const raceNumMatch = lower.match(/\brace\s+(\d{1,2})\b/);
  const raceNumber = raceNumMatch ? parseInt(raceNumMatch[1]) : null;

  // Track hint: word(s) after "at", "in", or "on" that start with a capital
  const trackMatch = query.match(/\b(?:at|in)\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+){0,2})\b/);
  const trackHint = trackMatch ? trackMatch[1] : null;

  // Date hint: "May 2", "April 5", etc. — assume 2026
  const MONTHS: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };
  let dateHint: string | null = null;
  const dateMatch = lower.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})\b/
  );
  if (dateMatch) {
    const mon = MONTHS[dateMatch[1]];
    const day = parseInt(dateMatch[2]);
    if (mon && day >= 1 && day <= 31) {
      dateHint = `2026-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  // Need at least a race number, or both a track and a date
  if (raceNumber == null && (trackHint == null || dateHint == null)) return null;

  return { raceNumber, trackHint, dateHint };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve a RaceRef to a single race_id. Returns null when ambiguous or absent.
// ─────────────────────────────────────────────────────────────────────────────
async function resolveRace(
  ref: RaceRef,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string | null> {
  let trackId: string | null = null;

  if (ref.trackHint) {
    const { data: byName } = await admin
      .from("tracks")
      .select("id")
      .ilike("name", `%${ref.trackHint}%`)
      .limit(1)
      .maybeSingle();
    trackId = byName?.id ?? null;

    if (!trackId) {
      const { data: byAbbr } = await admin
        .from("tracks")
        .select("id")
        .ilike("abbreviation", `%${ref.trackHint}%`)
        .limit(1)
        .maybeSingle();
      trackId = byAbbr?.id ?? null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q = admin.from("races").select("id") as any;
  if (ref.raceNumber != null) q = q.eq("race_number", ref.raceNumber);
  if (ref.dateHint) q = q.eq("race_date", ref.dateHint);
  if (trackId) q = q.eq("track_id", trackId);

  const { data, error } = await q.limit(1).maybeSingle();
  if (error) {
    console.error("[brain/resolveRace] error:", error.message);
    return null;
  }
  return (data as { id: string } | null)?.id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Build context for a fully resolved race: all entries + prior PP history.
// No horse or row cap — returns the complete field.
// ─────────────────────────────────────────────────────────────────────────────
async function buildRaceAnchoredContext(
  raceId: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string> {
  const { data: race } = await admin
    .from("races")
    .select("race_number, race_name, race_date, distance, surface, condition, class_level, purse, tracks(name, abbreviation)")
    .eq("id", raceId)
    .single();

  type EntryRow = {
    horse_id: string;
    finish_position: number | null;
    odds: number | null;
    beyer_figure: number | null;
    equibase_speed_fig: number | null;
    timeform_rating: number | null;
    frac_quarter: string | null;
    frac_half: string | null;
    frac_three_quarters: string | null;
    final_time: string | null;
    running_style: string | null;
    weight_carried: number | null;
    trip_notes: string | null;
    trouble_line: string | null;
    horses: {
      id: string; name: string; sire: string | null; dam: string | null;
      dam_sire: string | null; trainer: string | null; jockey: string | null;
      owner: string | null; age: number | null; sex: string | null; notes: string | null;
    } | {
      id: string; name: string; sire: string | null; dam: string | null;
      dam_sire: string | null; trainer: string | null; jockey: string | null;
      owner: string | null; age: number | null; sex: string | null; notes: string | null;
    }[] | null;
  };

  const { data: entries, error: entryErr } = await admin
    .from("performance")
    .select(`
      horse_id, finish_position, odds,
      beyer_figure, equibase_speed_fig, timeform_rating,
      frac_quarter, frac_half, frac_three_quarters, final_time,
      running_style, weight_carried, trip_notes, trouble_line,
      horses(id, name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, notes)
    `)
    .eq("race_id", raceId);

  if (entryErr) console.error("[brain/raceContext] entries error:", entryErr.message);
  if (!entries || entries.length === 0) return "";

  const horseIds = (entries as EntryRow[]).map((e) => e.horse_id);

  // Prior race history for all horses in this race — batch, no N+1
  type PriorRow = {
    horse_id: string;
    finish_position: number | null;
    beyer_figure: number | null;
    equibase_speed_fig: number | null;
    frac_quarter: string | null;
    frac_half: string | null;
    frac_three_quarters: string | null;
    final_time: string | null;
    running_style: string | null;
    odds: number | null;
    trip_notes: string | null;
    races: {
      race_date?: string; race_number?: number; distance?: string;
      surface?: string; condition?: string; class_level?: string;
      tracks?: { name?: string; abbreviation?: string } | { name?: string; abbreviation?: string }[] | null;
    } | null;
  };

  const { data: priorPerfs } = await admin
    .from("performance")
    .select(`
      horse_id, finish_position, beyer_figure, equibase_speed_fig,
      frac_quarter, frac_half, frac_three_quarters, final_time,
      running_style, odds, trip_notes,
      races(race_date, race_number, distance, surface, condition, class_level, tracks(name, abbreviation))
    `)
    .in("horse_id", horseIds)
    .neq("race_id", raceId)
    .limit(horseIds.length * 5);

  const priorByHorse = new Map<string, PriorRow[]>();
  for (const p of (priorPerfs ?? []) as PriorRow[]) {
    const list = priorByHorse.get(p.horse_id) ?? [];
    list.push(p);
    priorByHorse.set(p.horse_id, list);
  }

  const lines: string[] = ["--- Brain Knowledge Base — Extracted Racing Data ---", ""];

  if (race) {
    const track = Array.isArray(race.tracks) ? race.tracks[0] : race.tracks;
    const header = [
      `RACE ${race.race_number}`,
      race.race_name ? `— ${race.race_name}` : null,
      track?.name ? `at ${track.name}` : null,
      race.race_date,
      [race.distance, race.surface].filter(Boolean).join(" "),
      race.condition ? `(${race.condition})` : null,
      race.class_level ?? null,
      race.purse ? `Purse: $${Number(race.purse).toLocaleString()}` : null,
    ].filter(Boolean).join(" · ");
    lines.push(header);
    lines.push("");
  }

  for (const entry of entries as EntryRow[]) {
    const horse = Array.isArray(entry.horses) ? entry.horses[0] : entry.horses;
    if (!horse) continue;

    lines.push(
      [
        `HORSE: ${horse.name}`,
        horse.sex ? `(${horse.sex})` : null,
        horse.age ? `Age ${horse.age}` : null,
      ].filter(Boolean).join(" ")
    );

    const breeding = [
      horse.sire ? `Sire: ${horse.sire}` : null,
      horse.dam ? `Dam: ${horse.dam}` : null,
      horse.dam_sire ? `Dam Sire: ${horse.dam_sire}` : null,
    ].filter(Boolean).join(" | ");
    if (breeding) lines.push(`  Breeding: ${breeding}`);

    const connections = [
      horse.trainer ? `Trainer: ${horse.trainer}` : null,
      horse.jockey ? `Jockey: ${horse.jockey}` : null,
      horse.owner ? `Owner: ${horse.owner}` : null,
    ].filter(Boolean).join(" | ");
    if (connections) lines.push(`  Connections: ${connections}`);

    if (horse.notes) lines.push(`  Notes: ${horse.notes}`);

    const entryData = [
      entry.finish_position != null ? `Finish: ${entry.finish_position}` : null,
      entry.odds != null ? `ML Odds: ${entry.odds}` : null,
      entry.beyer_figure != null ? `Beyer: ${entry.beyer_figure}` : null,
      entry.equibase_speed_fig != null ? `EQ: ${entry.equibase_speed_fig}` : null,
      entry.timeform_rating != null ? `TF: ${entry.timeform_rating}` : null,
      entry.frac_quarter ? `Q: ${entry.frac_quarter}` : null,
      entry.frac_half ? `H: ${entry.frac_half}` : null,
      entry.frac_three_quarters ? `¾: ${entry.frac_three_quarters}` : null,
      entry.final_time ? `Final: ${entry.final_time}` : null,
      entry.running_style ? `Style: ${entry.running_style}` : null,
      entry.weight_carried != null ? `Wt: ${entry.weight_carried}` : null,
    ].filter(Boolean).join(" | ");
    if (entryData) lines.push(`  This Race: ${entryData}`);
    if (entry.trip_notes) lines.push(`  Trip: ${entry.trip_notes}`);
    if (entry.trouble_line) lines.push(`  Trouble: ${entry.trouble_line}`);

    const prior = (priorByHorse.get(entry.horse_id) ?? [])
      .sort((a, b) => (b.races?.race_date ?? "").localeCompare(a.races?.race_date ?? ""))
      .slice(0, 3);

    if (prior.length > 0) {
      lines.push("  Prior Races:");
      for (const p of prior) {
        const r = p.races;
        const t = Array.isArray(r?.tracks) ? r?.tracks[0] : r?.tracks;
        const raceLine = [
          r?.race_date,
          t?.name ?? t?.abbreviation ?? "Unknown",
          r?.race_number != null ? `Race ${r.race_number}` : null,
          [r?.distance, r?.surface].filter(Boolean).join(" "),
          r?.condition ? `(${r.condition})` : null,
        ].filter(Boolean).join(" · ");
        const perfLine = [
          p.finish_position != null ? `Finish: ${p.finish_position}` : null,
          p.beyer_figure != null ? `Beyer: ${p.beyer_figure}` : null,
          p.equibase_speed_fig != null ? `EQ: ${p.equibase_speed_fig}` : null,
          p.frac_quarter ? `Q: ${p.frac_quarter}` : null,
          p.frac_half ? `H: ${p.frac_half}` : null,
          p.running_style ? `Style: ${p.running_style}` : null,
          p.odds != null ? `Odds: ${p.odds}` : null,
        ].filter(Boolean).join(" | ");
        if (raceLine) lines.push(`    ${raceLine}`);
        if (perfLine) lines.push(`    ${perfLine}`);
        if (p.trip_notes) lines.push(`    Trip: ${p.trip_notes}`);
      }
    }

    lines.push("");
  }

  // Connections for trainers/jockeys in the field
  const trainerNames: string[] = [];
  const jockeyNames: string[] = [];
  for (const entry of entries as EntryRow[]) {
    const horse = Array.isArray(entry.horses) ? entry.horses[0] : entry.horses;
    if (!horse) continue;
    if (horse.trainer) trainerNames.push(horse.trainer);
    if (horse.jockey) jockeyNames.push(horse.jockey);
  }
  const connNames = [
    ...Array.from(new Set(trainerNames)).slice(0, 10),
    ...Array.from(new Set(jockeyNames)).slice(0, 10),
  ];

  if (connNames.length > 0) {
    const { data: conns } = await admin
      .from("connections")
      .select("name, role, win_pct, itm_pct, roi, specialty_distance, specialty_surface, notes")
      .in("name", connNames);

    if (conns && conns.length > 0) {
      lines.push("CONNECTIONS:");
      for (const c of conns) {
        const stats = [
          c.win_pct != null ? `Win: ${c.win_pct}%` : null,
          c.itm_pct != null ? `ITM: ${c.itm_pct}%` : null,
          c.roi != null ? `ROI: ${c.roi}` : null,
          c.specialty_distance ? `Dist: ${c.specialty_distance}` : null,
          c.specialty_surface ? `Surface: ${c.specialty_surface}` : null,
        ].filter(Boolean).join(" | ");
        lines.push(`  ${c.name} (${c.role})${stats ? ` — ${stats}` : ""}`);
        if (c.notes) lines.push(`    ${c.notes}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract candidate horse/track name terms from the user query.
// ─────────────────────────────────────────────────────────────────────────────
function extractQueryTerms(query: string): string[] {
  if (!query) return [];

  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "has", "have", "had",
    "will", "can", "does", "do", "did", "not", "but", "and", "or", "for",
    "on", "in", "at", "by", "with", "what", "how", "why", "when", "where",
    "who", "which", "this", "that", "these", "those", "about", "tell", "me",
    "show", "give", "find", "get", "his", "her", "its", "our", "their", "your",
    "race", "horse", "track", "ran", "run", "won", "win", "lost", "finish",
  ]);

  const terms: string[] = [];
  const seen = new Set<string>();

  const matches = Array.from(query.matchAll(/\b([A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,3})\b/g));
  for (const m of matches) {
    const term = m[1].trim();
    const lower = term.toLowerCase();
    if (term.length >= 3 && !stopWords.has(lower) && !seen.has(lower)) {
      terms.push(term);
      seen.add(lower);
    }
  }

  return terms.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build structured context. Returns { context, gate } where gate is the
// hallucination guard string (non-null only when a race ref was detected but
// couldn't be resolved to data).
// ─────────────────────────────────────────────────────────────────────────────
async function buildSchemaContext(
  userId: string,
  userQuery: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<{ context: string; gate: string | null }> {

  // ── Race-anchored path ────────────────────────────────────────────────────
  const raceRef = extractRaceReference(userQuery);
  if (raceRef) {
    console.log("[brain/schema] race ref detected:", JSON.stringify(raceRef));
    const raceId = await resolveRace(raceRef, admin);
    console.log("[brain/schema] resolved race_id:", raceId ?? "null");
    if (!raceId) {
      return { context: "", gate: RACE_HALLUCINATION_GATE };
    }
    const context = await buildRaceAnchoredContext(raceId, admin);
    if (!context) {
      return { context: "", gate: RACE_HALLUCINATION_GATE };
    }
    console.log("[brain/schema] race-anchored context chars:", context.length);
    return { context, gate: null };
  }

  // ── Term-match + baseline path ────────────────────────────────────────────
  const terms = extractQueryTerms(userQuery);
  console.log("[brain/schema] userId:", userId, "| query terms:", terms);

  const { count: uploadedByCount, error: countErr } = await admin
    .from("horses")
    .select("id", { count: "exact", head: true })
    .eq("uploaded_by", userId);
  if (countErr) console.error("[brain/schema] uploaded_by count error:", countErr.message);
  console.log("[brain/schema] horses with uploaded_by =", userId, ":", uploadedByCount ?? 0);

  // Baseline limit raised to 500 — shared Brain now has 200+ horses and will grow.
  // A 50-row cap caused shared horses outside the top-50 (by created_at) to be
  // invisible to lowercase matching, producing silent misses on valid queries.
  const { data: ownHorses, error: ownErr } = await admin
    .from("horses")
    .select("id, name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, notes")
    .or(`uploaded_by.eq.${userId},brain_layer.eq.shared`)
    .order("created_at", { ascending: false })
    .limit(500);

  if (ownErr) console.error("[brain/schema] ownHorses query error:", ownErr.message);
  console.log(
    "[brain/schema] ownHorses rows:", ownHorses?.length ?? 0,
    "| names:", ownHorses?.slice(0, 10).map((h) => h.name).join(", ") || "none",
  );

  // Term-match search
  const termMatches: NonNullable<typeof ownHorses> = [];
  if (terms.length > 0) {
    for (const term of terms.slice(0, 4)) {
      const { data } = await admin
        .from("horses")
        .select("id, name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, notes")
        .ilike("name", `%${term}%`)
        .or(`brain_layer.eq.shared,uploaded_by.eq.${userId}`)
        .limit(5);
      if (data) termMatches.push(...data);
    }
    console.log("[brain/schema] termMatches rows:", termMatches.length);
  }

  // Lowercase fallback — now covers the full 500-row baseline
  const lowercaseMatches: NonNullable<typeof ownHorses> = [];
  if (ownHorses && ownHorses.length > 0) {
    const queryLower = userQuery.toLowerCase();
    for (const horse of ownHorses) {
      if (queryLower.includes(horse.name.toLowerCase())) {
        lowercaseMatches.push(horse);
      }
    }
  }

  // Merge: explicit mentions first, then term matches, then baseline
  const seen = new Set<string>();
  const horses = [...lowercaseMatches, ...termMatches, ...(ownHorses ?? [])].filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });

  console.log("[brain/schema] merged horse count:", horses.length);

  if (horses.length === 0) return { context: "", gate: null };

  const lines: string[] = [
    "--- Brain Knowledge Base — Extracted Racing Data ---",
    "",
  ];

  const topHorses = horses.slice(0, 15);
  const horseIds = topHorses.map((h) => h.id);

  type PerfRow = {
    horse_id: string;
    finish_position: number | null;
    lengths_beaten: number | null;
    beyer_figure: number | null;
    beyer_source: string | null;
    equibase_speed_fig: number | null;
    equibase_source: string | null;
    timeform_rating: number | null;
    timeform_source: string | null;
    frac_quarter: string | null;
    frac_quarter_sec: number | null;
    frac_half: string | null;
    frac_half_sec: number | null;
    frac_three_quarters: string | null;
    frac_three_quarters_sec: number | null;
    final_time: string | null;
    running_style: string | null;
    weight_carried: number | null;
    odds: number | null;
    trip_notes: string | null;
    trouble_line: string | null;
    races: {
      race_date?: string; race_number?: number; distance?: string;
      surface?: string; condition?: string; class_level?: string; purse?: number;
      tracks?: { name?: string; abbreviation?: string } | null;
    } | null;
  };

  const { data: allPerfs } = await admin
    .from("performance")
    .select(`
      horse_id,
      finish_position, lengths_beaten,
      beyer_figure, beyer_source,
      equibase_speed_fig, equibase_source,
      timeform_rating, timeform_source,
      frac_quarter, frac_quarter_sec,
      frac_half, frac_half_sec,
      frac_three_quarters, frac_three_quarters_sec,
      final_time, running_style, weight_carried, odds,
      trip_notes, trouble_line,
      races (
        race_date, race_number, distance, surface, condition, class_level, purse,
        tracks ( name, abbreviation )
      )
    `)
    .in("horse_id", horseIds)
    .limit(120);

  const perfsByHorseId = new Map<string, PerfRow[]>();
  for (const p of (allPerfs ?? []) as PerfRow[]) {
    const list = perfsByHorseId.get(p.horse_id) ?? [];
    list.push(p);
    perfsByHorseId.set(p.horse_id, list);
  }

  for (const horse of topHorses) {
    lines.push(
      [
        `HORSE: ${horse.name}`,
        horse.sex ? `(${horse.sex})` : null,
        horse.age ? `Age ${horse.age}` : null,
      ].filter(Boolean).join(" ")
    );

    const breeding = [
      horse.sire ? `Sire: ${horse.sire}` : null,
      horse.dam ? `Dam: ${horse.dam}` : null,
      horse.dam_sire ? `Dam Sire: ${horse.dam_sire}` : null,
    ].filter(Boolean).join(" | ");
    if (breeding) lines.push(`  Breeding: ${breeding}`);

    const connections = [
      horse.trainer ? `Trainer: ${horse.trainer}` : null,
      horse.jockey ? `Jockey: ${horse.jockey}` : null,
      horse.owner ? `Owner: ${horse.owner}` : null,
    ].filter(Boolean).join(" | ");
    if (connections) lines.push(`  Connections: ${connections}`);

    if (horse.notes) lines.push(`  Notes: ${horse.notes}`);

    const perfs = perfsByHorseId.get(horse.id) ?? [];

    if (perfs.length > 0) {
      const sorted = [...perfs]
        .sort((a, b) => {
          const da = a.races?.race_date ?? "";
          const db = b.races?.race_date ?? "";
          return db.localeCompare(da);
        })
        .slice(0, 5);

      lines.push("  Performance:");
      for (const p of sorted) {
        const race = p.races;
        const track = race?.tracks;
        const trackName = track?.name ?? track?.abbreviation ?? "Unknown";

        const raceHeader = [
          race?.race_date,
          trackName,
          race?.race_number != null ? `Race ${race.race_number}` : null,
          race?.class_level,
          [race?.distance, race?.surface].filter(Boolean).join(" "),
          race?.condition ? `(${race.condition})` : null,
        ].filter(Boolean).join(" · ");
        lines.push(`    ${raceHeader}`);

        const result = [
          p.finish_position != null ? `Finish: ${p.finish_position}` : null,
          p.lengths_beaten != null ? `Margin: ${p.lengths_beaten}L` : null,
          p.beyer_figure != null
            ? `Beyer: ${p.beyer_figure}${p.beyer_source ? ` (${p.beyer_source})` : ""}`
            : null,
          p.equibase_speed_fig != null
            ? `EQ: ${p.equibase_speed_fig}${p.equibase_source ? ` (${p.equibase_source})` : ""}`
            : null,
          p.timeform_rating != null
            ? `TF: ${p.timeform_rating}${p.timeform_source ? ` (${p.timeform_source})` : ""}`
            : null,
          p.frac_quarter ? `Q: ${p.frac_quarter}` : null,
          p.frac_half ? `H: ${p.frac_half}` : null,
          p.frac_three_quarters ? `¾: ${p.frac_three_quarters}` : null,
          p.final_time ? `Final: ${p.final_time}` : null,
          p.running_style ? `Style: ${p.running_style}` : null,
          p.weight_carried != null ? `Wt: ${p.weight_carried}` : null,
          p.odds != null ? `Odds: ${p.odds}` : null,
        ].filter(Boolean).join(" | ");
        if (result) lines.push(`    ${result}`);
        if (p.trip_notes) lines.push(`    Trip: ${p.trip_notes}`);
        if (p.trouble_line) lines.push(`    Trouble: ${p.trouble_line}`);
      }
    } else {
      lines.push("  No performance records extracted.");
    }

    lines.push("");
  }

  const trainerNames = Array.from(new Set(horses.map((h) => h.trainer).filter((n): n is string => !!n)));
  const jockeyNames = Array.from(new Set(horses.map((h) => h.jockey).filter((n): n is string => !!n)));
  const allConnNames = [...trainerNames.slice(0, 5), ...jockeyNames.slice(0, 5)];

  if (allConnNames.length > 0) {
    const { data: conns } = await admin
      .from("connections")
      .select("name, role, win_pct, itm_pct, roi, specialty_distance, specialty_surface, notes")
      .in("name", allConnNames);

    if (conns && conns.length > 0) {
      lines.push("CONNECTIONS:");
      for (const c of conns) {
        const stats = [
          c.win_pct != null ? `Win: ${c.win_pct}%` : null,
          c.itm_pct != null ? `ITM: ${c.itm_pct}%` : null,
          c.roi != null ? `ROI: ${c.roi}` : null,
          c.specialty_distance ? `Dist: ${c.specialty_distance}` : null,
          c.specialty_surface ? `Surface: ${c.specialty_surface}` : null,
        ].filter(Boolean).join(" | ");
        lines.push(`  ${c.name} (${c.role})${stats ? ` — ${stats}` : ""}`);
        if (c.notes) lines.push(`    ${c.notes}`);
      }
      lines.push("");
    }
  }

  return { context: lines.join("\n"), gate: null };
}

export async function POST(request: Request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("[brain] FATAL: ANTHROPIC_API_KEY is not set");
    return new Response(JSON.stringify({ error: "Server misconfiguration: missing API key" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    console.error("[brain] FATAL: Supabase env vars missing — URL or ANON_KEY not set");
  }

  console.log("[brain] POST request received");

  try {
    const body = await request.json();
    const { messages, conversation_id, user_message } = body as {
      messages: Array<{ role: "user" | "assistant"; content: string }>;
      conversation_id?: string;
      user_message?: string;
    };

    if (!messages || !Array.isArray(messages)) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    console.log("[brain] messages count:", messages.length, "| conversation_id:", conversation_id ?? "none");

    const admin = createAdminClient();

    // ── Community intelligence ─────────────────────────────────────────────
    let sharedIntelligenceContext = "";
    let relevantCommunityContext = "";
    let cappedCommunityContext = "";
    try {
      const { data: sharedPosts, error: sharedErr } = await admin
        .from("posts")
        .select("username, user_email, content, created_at")
        .eq("brain_verified", true)
        .order("created_at", { ascending: false })
        .limit(10);

      if (sharedErr) {
        console.error("[brain] shared posts query error:", sharedErr.message);
      } else if (sharedPosts && sharedPosts.length > 0) {
        const COMMUNITY_HEADER =
          `--- Community Intelligence — publicly shared findings from HiveCap users ---\n` +
          `The following posts were verified by the Brain and shared by the community. ` +
          `Treat them as supplementary analyst notes — useful signal, but defer to the ` +
          `extracted Knowledge Base and the user's own analysis when they conflict.\n\n`;

        const makeEntry = (p: typeof sharedPosts[number], maxChars: number) => {
          const author = p.username ?? p.user_email;
          const date = new Date(p.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          const body = p.content.length > maxChars ? p.content.slice(0, maxChars) + "…" : p.content;
          return `[${author} · ${date}]\n${body}`;
        };

        const entries300 = sharedPosts.map((p) => makeEntry(p, 300));
        sharedIntelligenceContext = COMMUNITY_HEADER + entries300.join("\n\n");

        const queryTerms = extractQueryTerms(user_message ?? "");
        const queryWords = (user_message ?? "")
          .toLowerCase()
          .split(/\s+/)
          .map((w) => w.replace(/[^a-z]/g, ""))
          .filter((w) => w.length >= 6);

        const relevantPosts = sharedPosts.filter((_, i) => {
          const entryLower = entries300[i].toLowerCase();
          const termMatch = queryTerms.some((t) => t.length >= 6 && entryLower.includes(t.toLowerCase()));
          if (termMatch) return true;
          return queryWords.some((w) => entryLower.includes(w));
        });

        if (relevantPosts.length > 0) {
          relevantCommunityContext = COMMUNITY_HEADER + relevantPosts.map((p) => makeEntry(p, 300)).join("\n\n");
          cappedCommunityContext = COMMUNITY_HEADER + relevantPosts.slice(0, 3).map((p) => makeEntry(p, 200)).join("\n\n");
        }

        console.log("[brain] community posts — total:", sharedPosts.length, "| relevant:", relevantPosts.length);
      }
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      console.error("[brain] community posts failed:", e?.message);
      if (e?.cause) console.error("[brain] community posts cause:", e.cause);
    }

    // ── Auth ───────────────────────────────────────────────────────────────
    let userId: string | null = null;
    try {
      const supabase = createClient();
      const { data: { user }, error: authErr } = await supabase.auth.getUser();
      if (authErr) {
        console.error("[brain] auth failed:", authErr.message, "| code:", authErr.status);
      } else if (user) {
        userId = user.id;
        console.log("[brain] authenticated user:", userId);
      } else {
        console.warn("[brain] no authenticated user — persistence and docs disabled");
      }
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      console.error("[brain] auth threw:", e?.message);
      if (e?.cause) console.error("[brain] auth cause:", e.cause);
    }

    // ── Schema context ─────────────────────────────────────────────────────
    let schemaContext = "";
    let hallucGate: string | null = null;
    if (userId) {
      try {
        const result = await buildSchemaContext(userId, user_message ?? "", admin);
        schemaContext = result.context;
        hallucGate = result.gate;
        console.log("[brain] schema context chars:", schemaContext.length, "| gate:", hallucGate ? "YES" : "none");
      } catch (err) {
        console.error("[brain] schema context query failed:", (err as Error).message);
      }
    }

    // ── Resolve conversation ───────────────────────────────────────────────
    let activeConvId: string | null = conversation_id ?? null;

    if (userId) {
      if (activeConvId) {
        console.log("[brain] Using existing conversation:", activeConvId);
      } else {
        const supabase = createClient();
        const title = user_message ? user_message.slice(0, 60) : "New conversation";
        const { data: conv, error: convErr } = await supabase
          .from("conversations")
          .insert({ user_id: userId, title })
          .select("id")
          .single();

        if (convErr) {
          console.error("[brain] Failed to create conversation:", convErr.message, convErr);
        } else {
          activeConvId = conv.id;
          console.log("[brain] Created new conversation:", activeConvId);
        }
      }
    }

    // ── Save user message (fire-and-forget) ───────────────────────────────
    if (userId && activeConvId && user_message) {
      const supabase = createClient();
      supabase
        .from("messages")
        .insert({
          conversation_id: activeConvId,
          user_id: userId,
          role: "user",
          content: user_message,
        })
        .then(({ error }) => {
          if (error) console.error("[brain] Failed to save user message:", error.message);
          else console.log("[brain] Saved user message to conversation:", activeConvId);
        });
    }

    // ── Build system prompt ────────────────────────────────────────────────
    const contextParts: string[] = [BASE_PROMPT];
    if (schemaContext) contextParts.push(schemaContext);
    if (hallucGate) contextParts.push(hallucGate);
    const communityForClaude = schemaContext ? cappedCommunityContext : relevantCommunityContext;
    if (communityForClaude) contextParts.push(communityForClaude);

    const systemPrompt = contextParts.join("\n\n");

    // ── Validate and trim message list ────────────────────────────────────
    const anthropicMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => !(m.role === "assistant" && isUiStateMessage(m.content)))
      .slice(-10)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    while (
      anthropicMessages.length > 0 &&
      anthropicMessages[anthropicMessages.length - 1].role === "assistant"
    ) {
      anthropicMessages.pop();
    }

    if (anthropicMessages.length === 0) {
      return new Response(JSON.stringify({ error: "No user messages found" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Stream ─────────────────────────────────────────────────────────────
    const model = "claude-sonnet-4-6";
    console.log("[brain] prompt budget — system:", systemPrompt.length, "chars | schema:", schemaContext.length, "chars | community:", sharedIntelligenceContext.length, "chars | messages:", anthropicMessages.length);

    let stream: AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>;
    try {
      stream = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: [{ type: "web_search_20250305", name: "web_search" }] as any,
        stream: true,
      }) as AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>;
    } catch (anthropicErr) {
      const e = anthropicErr as Error & { status?: number; error?: unknown };
      console.error("[brain] Anthropic API call failed:");
      console.error("  name:", e.name);
      console.error("  message:", e.message);
      console.error("  status:", e.status);
      console.error("  error body:", JSON.stringify(e.error ?? null));
      console.error("  stack:", e.stack);
      return new Response(
        JSON.stringify({ error: "AI service error: " + e.message }),
        { status: 502, headers: { "Content-Type": "application/json" } }
      );
    }
    console.error("[brain] Anthropic stream opened successfully");

    const capturedUserId = userId;
    const capturedConvId = activeConvId;

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let fullText = "";
        try {
          for await (const chunk of stream) {
            if (chunk.type !== "content_block_delta") continue;
            if (chunk.delta?.type !== "text_delta") continue;
            if (!chunk.delta.text) continue;
            fullText += chunk.delta.text;
            controller.enqueue(encoder.encode(chunk.delta.text));
          }
          controller.close();
        } catch (err) {
          const e = err as Error & { status?: number; cause?: unknown };
          console.error("[brain] anthropic stream failed:", e?.message);
          console.error("[brain] anthropic stream status:", e?.status);
          if (e?.cause) console.error("[brain] anthropic stream cause:", e.cause);
          controller.error(err);
        }

        if (capturedUserId && capturedConvId && fullText) {
          try {
            const supabase = createClient();
            const [msgResult, convResult] = await Promise.all([
              supabase.from("messages").insert({
                conversation_id: capturedConvId,
                user_id: capturedUserId,
                role: "assistant",
                content: fullText,
              }),
              supabase
                .from("conversations")
                .update({ updated_at: new Date().toISOString() })
                .eq("id", capturedConvId),
            ]);
            if (msgResult.error)
              console.error("[brain] Failed to save assistant message:", msgResult.error.message);
            if (convResult.error)
              console.error("[brain] Failed to update conversation timestamp:", convResult.error.message);
            else
              console.log("[brain] Persisted assistant message to conversation:", capturedConvId);
          } catch (err) {
            console.error("[brain] Post-stream persist threw:", err);
          }
        }
      },
    });

    return new Response(readableStream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
        "X-Content-Type-Options": "nosniff",
        ...(activeConvId ? { "X-Conversation-Id": activeConvId } : {}),
      },
    });
  } catch (error) {
    const e = error as Error & { status?: number; error?: unknown; code?: string; cause?: unknown };
    console.error("[brain] unhandled error in POST handler:");
    console.error("  name:", e?.name);
    console.error("  message:", e?.message);
    console.error("  status:", e?.status);
    console.error("  code:", e?.code);
    console.error("  cause:", e?.cause);
    console.error("  error body:", JSON.stringify(e?.error ?? null));
    console.error("  stack:", e?.stack);
    const message = e?.message ?? "Internal server error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
