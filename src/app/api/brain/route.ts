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
// Scope detection helpers — parse track names, race dates, and race numbers
// from the last 6 user messages to resolve targeted race context.
// ─────────────────────────────────────────────────────────────────────────────

const KNOWN_TRACKS: Array<{ patterns: RegExp[]; canonical: string }> = [
  { patterns: [/\bchurchill\b/i, /\bchurchill\s+downs\b/i], canonical: "Churchill Downs" },
  { patterns: [/\baqueduct\b/i, /\baqu\b/i], canonical: "Aqueduct" },
  { patterns: [/\bkeeneland\b/i], canonical: "Keeneland" },
  { patterns: [/\bgulfstream\b/i], canonical: "Gulfstream Park" },
  { patterns: [/\bsanta\s+anita\b/i], canonical: "Santa Anita Park" },
  { patterns: [/\boaklawn\b/i], canonical: "Oaklawn Park" },
  { patterns: [/\bbelmont\b/i], canonical: "Belmont Park" },
  { patterns: [/\bsaratoga\b/i], canonical: "Saratoga" },
  { patterns: [/\bpimlico\b/i], canonical: "Pimlico" },
];

function detectTracks(text: string): string[] {
  const hits = new Set<string>();
  for (const t of KNOWN_TRACKS) {
    if (t.patterns.some((p) => p.test(text))) hits.add(t.canonical);
  }
  return Array.from(hits);
}

function detectRaceNumbers(text: string): number[] {
  const hits = new Set<number>();
  const re = /\b(?:race\s+|r)(\d{1,2})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 14) hits.add(n);
  }
  return Array.from(hits);
}

function detectRaceDates(text: string): string[] {
  const hits = new Set<string>();
  const monthNames: Record<string, number> = {
    january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
    may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
    september: 9, sept: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
  };
  const currentYear = new Date().getUTCFullYear();

  // "May 2, 2026" / "May 2 2026" / "May 2"
  const monthRe = /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/gi;
  let m: RegExpExecArray | null;
  while ((m = monthRe.exec(text)) !== null) {
    const month = monthNames[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = m[3] ? parseInt(m[3], 10) : currentYear;
    if (month && day >= 1 && day <= 31) {
      hits.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }

  // Numeric: "5/2", "5/2/2026", "5-2-2026"
  const numRe = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/g;
  while ((m = numRe.exec(text)) !== null) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    let year = m[3] ? parseInt(m[3], 10) : currentYear;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      hits.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
  }

  return Array.from(hits);
}

interface RaceScope {
  tracks: string[];
  dates: string[];
  raceNumbers: number[];
  raceNames: string[];
  hasAny: boolean;
}

async function detectRaceNames(
  admin: ReturnType<typeof createAdminClient>,
  text: string
): Promise<string[]> {
  // Pull all distinct race_names from races table — small set, cheap query
  const { data: races } = await admin
    .from("races")
    .select("race_name")
    .not("race_name", "is", null);

  if (!races || races.length === 0) return [];

  const distinctNames = Array.from(
    new Set(
      races
        .map((r: any) => r.race_name)
        .filter((n: any) => typeof n === "string" && n.trim().length >= 4)
    )
  );

  const lowerText = text.toLowerCase();
  const hits: string[] = [];
  for (const name of distinctNames) {
    if (lowerText.includes((name as string).toLowerCase())) {
      hits.push(name as string);
    }
  }
  return hits;
}

async function extractRaceScope(
  admin: ReturnType<typeof createAdminClient>,
  messages: Array<{ role: string; content: string }>
): Promise<RaceScope> {
  const userMessages = messages.filter((m) => m.role === "user").slice(-6);
  const blob = userMessages.map((m) => m.content).join("\n");

  const tracks = detectTracks(blob);
  const dates = detectRaceDates(blob);
  const raceNumbers = detectRaceNumbers(blob);
  const raceNames = await detectRaceNames(admin, blob);

  return {
    tracks,
    dates,
    raceNumbers,
    raceNames,
    hasAny:
      tracks.length > 0 ||
      dates.length > 0 ||
      raceNumbers.length > 0 ||
      raceNames.length > 0,
  };
}

async function resolveScopedRaceIds(
  admin: ReturnType<typeof createAdminClient>,
  scope: RaceScope,
): Promise<string[]> {
  if (!scope.hasAny) return [];

  // Race name is the most specific signal — resolve by name first
  if (scope.raceNames.length > 0) {
    const { data: nameRaces } = await admin
      .from("races")
      .select("id")
      .in("race_name", scope.raceNames)
      .limit(20);
    const ids = (nameRaces ?? []).map((r: any) => r.id);
    if (ids.length > 0) return ids;
    // fall through if name match returned nothing (typo, partial match, etc.)
  }

  let trackIds: string[] = [];
  if (scope.tracks.length > 0) {
    const { data: tracks } = await admin
      .from("tracks")
      .select("id, name")
      .in("name", scope.tracks);
    trackIds = (tracks ?? []).map((t: any) => t.id);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = admin.from("races").select("id") as any;
  if (trackIds.length > 0) query = query.in("track_id", trackIds);
  if (scope.dates.length > 0) query = query.in("race_date", scope.dates);
  if (scope.raceNumbers.length > 0) query = query.in("race_number", scope.raceNumbers);
  query = query.limit(20);

  const { data: races } = await query;
  return (races ?? []).map((r: any) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Build structured Brain context with scope-resolved retrieval.
// Priority: personal horses → scoped shared horses → recent shared topup.
// Total capped at HORSE_BUDGET. Logs saturation to ingestion_log.
// ─────────────────────────────────────────────────────────────────────────────

const HORSE_BUDGET = 100;
const PERSONAL_CAP = 100;
const TOPUP_CAP = 50;

async function buildSchemaContext(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  conversationMessages: Array<{ role: string; content: string }>,
): Promise<{ contextText: string; horseCount: number; saturated: boolean }> {
  const scope = await extractRaceScope(admin, conversationMessages);
  console.log("[brain/schema] scope detected:", scope.hasAny, JSON.stringify({ tracks: scope.tracks, dates: scope.dates, raceNumbers: scope.raceNumbers, raceNames: scope.raceNames }));

  // 1. All personal horses, freshest first — never evicted
  const { data: personalHorses } = await admin
    .from("horses")
    .select("*")
    .eq("uploaded_by", userId)
    .order("created_at", { ascending: false })
    .limit(PERSONAL_CAP);

  // 2. Scope-resolved shared horses — full field, no row limit per race
  let scopedHorses: any[] = [];
  if (scope.hasAny) {
    const raceIds = await resolveScopedRaceIds(admin, scope);
    console.log("[brain/schema] resolved race_ids:", raceIds);
    if (raceIds.length > 0) {
      const { data: perfRows } = await admin
        .from("performance")
        .select("horse_id")
        .in("race_id", raceIds);
      const horseIds = Array.from(new Set((perfRows ?? []).map((p: any) => p.horse_id)));

      if (horseIds.length > 0) {
        const { data: scoped } = await admin
          .from("horses")
          .select("*")
          .in("id", horseIds)
          .or(`uploaded_by.eq.${userId},brain_layer.eq.shared`);
        scopedHorses = scoped ?? [];
      }
    }
  }

  // 3. Top up with recent shared horses for general-context queries
  const { data: topupHorses } = await admin
    .from("horses")
    .select("*")
    .eq("brain_layer", "shared")
    .order("created_at", { ascending: false })
    .limit(TOPUP_CAP);

  // 4. Merge with priority: personal → scoped → topup, dedupe by id
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const bucket of [personalHorses ?? [], scopedHorses, topupHorses ?? []]) {
    for (const h of bucket) {
      if (seen.has(h.id)) continue;
      if (merged.length >= HORSE_BUDGET) break;
      seen.add(h.id);
      merged.push(h);
    }
    if (merged.length >= HORSE_BUDGET) break;
  }

  // 5. Saturation check — log when shared Brain has more than what was returned
  const { count: totalSharedCount } = await admin
    .from("horses")
    .select("*", { count: "exact", head: true })
    .eq("brain_layer", "shared");
  const sharedReturned = merged.filter((h) => h.brain_layer === "shared").length;
  const saturated = (totalSharedCount ?? 0) > sharedReturned + scopedHorses.length;

  console.log("[brain/schema] merged:", merged.length, "| shared total:", totalSharedCount, "| shared returned:", sharedReturned, "| saturated:", saturated);

  if (saturated) {
    try {
      await admin.from("ingestion_log").insert({
        user_id: userId,
        source: "brain_query",
        status: "partial",
        notes: JSON.stringify({
          event: "shared_context_saturated",
          shared_returned: sharedReturned,
          shared_total: totalSharedCount,
          scope_detected: scope.hasAny,
          scope,
        }),
      });
    } catch (e) {
      console.warn("[brain] saturation log failed", e);
    }
  }

  if (merged.length === 0) {
    return { contextText: "", horseCount: 0, saturated };
  }

  const horseIds = merged.map((h) => h.id);

  // Batch performance query — no N+1
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
    frac_final: string | null;
    frac_final_sec: number | null;
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
      frac_final, frac_final_sec,
      final_time, running_style, weight_carried, odds,
      trip_notes, trouble_line,
      races (
        race_date, race_number, distance, surface, condition, class_level, purse,
        tracks ( name, abbreviation )
      )
    `)
    .in("horse_id", horseIds);

  const perfByHorse = new Map<string, PerfRow[]>();
  for (const p of (allPerfs ?? []) as PerfRow[]) {
    const list = perfByHorse.get(p.horse_id) ?? [];
    list.push(p);
    perfByHorse.set(p.horse_id, list);
  }

  // Connections batch query — no N+1
  const namesNeeded = new Set<string>();
  for (const h of merged) {
    if (h.trainer) namesNeeded.add(h.trainer);
    if (h.jockey) namesNeeded.add(h.jockey);
  }
  const connectionsByName = new Map<string, any>();
  if (namesNeeded.size > 0) {
    const { data: conns } = await admin
      .from("connections")
      .select("*")
      .in("name", Array.from(namesNeeded));
    for (const c of conns ?? []) connectionsByName.set(c.name, c);
  }

  // Build context text
  const lines: string[] = [];
  lines.push("# Brain Knowledge Base — Structured Data");
  if (saturated) {
    lines.push(`> Note: Shared Brain has more horses than fit in this context. Showing personal + scope-relevant + recent. Ask about a specific race for full coverage.`);
  }
  lines.push("");

  for (const h of merged) {
    const layer = h.brain_layer === "shared" ? "shared" : "personal";
    lines.push(`## ${h.name} [${layer}]`);
    if (h.sire || h.dam) {
      lines.push(`Pedigree: ${h.sire ?? "?"} × ${h.dam ?? "?"}${h.dam_sire ? ` (broodmare sire: ${h.dam_sire})` : ""}`);
    }
    if (h.trainer) {
      const c = connectionsByName.get(h.trainer);
      lines.push(`Trainer: ${h.trainer}${c ? ` (Win% ${c.win_pct ?? "n/a"}, ITM% ${c.itm_pct ?? "n/a"}, ROI ${c.roi ?? "n/a"})` : ""}`);
    }
    if (h.jockey) {
      const c = connectionsByName.get(h.jockey);
      lines.push(`Jockey: ${h.jockey}${c ? ` (Win% ${c.win_pct ?? "n/a"}, ITM% ${c.itm_pct ?? "n/a"})` : ""}`);
    }
    if (h.owner) lines.push(`Owner: ${h.owner}`);
    if (h.notes) lines.push(`Notes: ${h.notes}`);

    const perfs = (perfByHorse.get(h.id) ?? [])
      .sort((a, b) => (b.races?.race_date ?? "").localeCompare(a.races?.race_date ?? ""))
      .slice(0, 5);

    if (perfs.length > 0) {
      lines.push("Performance:");
      for (const p of perfs) {
        const race = p.races;
        const track = race?.tracks;
        const trackName = track?.name ?? track?.abbreviation ?? "?";
        const dateStr = race?.race_date ?? "?";
        const raceNum = race?.race_number != null ? `R${race.race_number}` : "";
        const dist = race?.distance ?? "";
        const surf = race?.surface ?? "";
        const beyer = p.beyer_figure != null ? `Beyer ${p.beyer_figure}` : "Beyer n/a";
        const eq = p.equibase_speed_fig != null ? `Equibase ${p.equibase_speed_fig}` : "";
        const fracs = [p.frac_quarter, p.frac_half, p.frac_three_quarters, p.frac_final].filter(Boolean).join(" / ");
        const style = p.running_style ? `style ${p.running_style}` : "";
        const finish = p.finish_position != null ? `Finish: ${p.finish_position}` : "";
        lines.push(
          `  - ${trackName} ${dateStr} ${raceNum} ${dist} ${surf} | ${beyer}${eq ? ` · ${eq}` : ""}${fracs ? ` · ${fracs}` : ""}${style ? ` · ${style}` : ""}${finish ? ` · ${finish}` : ""}`
        );
        if (p.trip_notes) lines.push(`    Trip: ${p.trip_notes}`);
        if (p.trouble_line) lines.push(`    Trouble: ${p.trouble_line}`);
      }
    }

    lines.push("");
  }

  return { contextText: lines.join("\n"), horseCount: merged.length, saturated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract candidate horse/track name terms from the user query.
// Used for community posts relevance filtering.
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

    // ── Filter messages (used for schema context AND Claude input) ─────────
    // Strip UI state messages before passing to extractRaceScope or Claude.
    const filteredMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .filter((m) => !(m.role === "assistant" && isUiStateMessage(m.content)));

    // ── Schema context ─────────────────────────────────────────────────────
    let schemaContext = "";
    if (userId) {
      try {
        const result = await buildSchemaContext(admin, userId, filteredMessages);
        schemaContext = result.contextText;
        console.log("[brain] schema context chars:", schemaContext.length, "| horses:", result.horseCount, "| saturated:", result.saturated);
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
    const KB_FRAMING =
      `Your structured Brain context for this query is below. This is the slice of the Brain database loaded for this turn — ` +
      `it includes the user's personal horses, horses scoped to any race the user has referenced, and recent shared horses. ` +
      `If the user asks about a horse or race not present here, do NOT say "I don't have that extracted" — ` +
      `say "Let me pull that race specifically" and ask the user to confirm the track + race number + date so a more targeted retrieval can run on the next turn. ` +
      `The full shared Brain database is larger than what is shown here.`;

    const contextParts: string[] = [BASE_PROMPT];
    if (schemaContext) contextParts.push(KB_FRAMING + "\n\n" + schemaContext);
    const communityForClaude = schemaContext ? cappedCommunityContext : relevantCommunityContext;
    if (communityForClaude) contextParts.push(communityForClaude);

    const systemPrompt = contextParts.join("\n\n");

    // ── Validate and trim message list ────────────────────────────────────
    const anthropicMessages = filteredMessages
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
