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
// These are assistant turns that reflect pipeline state, not conversation content.
const UI_STATE_PATTERNS = [
  /^I (?:found|see) \d+/i,           // scan prompt: "I found N race(s)..."
  /^Brain updated/i,                   // extraction confirmation
  /^Got it/i,                          // dedup / ready confirmation
  /Select a race to extract/i,         // race selector prompt
  /^We couldn't process/i,             // extraction failure message
  /^Extraction incomplete/i,           // max_tokens failure
];

function isUiStateMessage(content: string): boolean {
  return UI_STATE_PATTERNS.some((p) => p.test(content.trimStart()));
}


export const runtime = "nodejs";

// ─────────────────────────────────────────────────────────────────────────────
// Extract candidate horse/track name terms from the user query.
// Matches sequences of 1–4 capitalized words, skips common stop words.
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
// Build structured context from horses/races/performance/connections tables.
// Returns empty string if no data found (triggers user_documents fallback).
// ─────────────────────────────────────────────────────────────────────────────
async function buildSchemaContext(
  userId: string,
  userQuery: string,
  admin: ReturnType<typeof createAdminClient>,
): Promise<string> {
  const terms = extractQueryTerms(userQuery);
  console.log("[brain/schema] userId:", userId, "| query terms:", terms);
  console.log("[brain/schema] filter: uploaded_by.eq." + userId + " OR brain_layer.eq.shared");

  // Diagnostic: check how many horses exist with uploaded_by = userId specifically.
  // This confirms whether the extract route wrote uploaded_by correctly for this user.
  const { count: uploadedByCount, error: countErr } = await admin
    .from("horses")
    .select("id", { count: "exact", head: true })
    .eq("uploaded_by", userId);
  if (countErr) console.error("[brain/schema] uploaded_by count error:", countErr.message);
  console.log("[brain/schema] horses with uploaded_by =", userId, ":", uploadedByCount ?? 0);

  // Fetch all horses owned by this user OR in the shared Brain (up to 50).
  // This is the baseline — ensures the Brain always has context for the user's
  // own data even when the query contains no exact horse name.
  const { data: ownHorses, error: ownErr } = await admin
    .from("horses")
    .select("id, name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, notes")
    .or(`uploaded_by.eq.${userId},brain_layer.eq.shared`)
    .order("created_at", { ascending: false })
    .limit(50);

  if (ownErr) console.error("[brain/schema] ownHorses query error:", ownErr.message);
  console.log(
    "[brain/schema] ownHorses rows:", ownHorses?.length ?? 0,
    "| names:", ownHorses?.map((h) => h.name).join(", ") || "none",
  );

  // Term-match search: additionally prioritise horses whose name matches query terms.
  // Scoped to this user's horses OR shared Brain horses — never other users' personal data.
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

  // Lowercase fallback: find horses in the baseline whose name appears anywhere in the query.
  // Catches queries where the user types a horse name in lowercase (missed by the capitalized-word regex).
  const lowercaseMatches: NonNullable<typeof ownHorses> = [];
  if (ownHorses && ownHorses.length > 0) {
    const queryLower = userQuery.toLowerCase();
    for (const horse of ownHorses) {
      if (queryLower.includes(horse.name.toLowerCase())) {
        lowercaseMatches.push(horse);
      }
    }
  }

  // Merge: lowercase matches first (explicit mention), then capitalized term matches,
  // then own/shared baseline; dedup by id.
  const seen = new Set<string>();
  const horses = [...lowercaseMatches, ...termMatches, ...(ownHorses ?? [])].filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });

  console.log("[brain/schema] merged horse count:", horses.length);

  if (horses.length === 0) return "";

  const lines: string[] = [
    "--- Brain Knowledge Base — Extracted Racing Data ---",
    "",
  ];

  // FIX 1: Single batch query for all performances (replaces N+1 per-horse loop).
  // FIX 6: Include all fraction fields.
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
    .limit(120); // 8 per horse × 15 horses

  // Group performances by horse_id for O(1) lookup in rendering loop
  const perfsByHorseId = new Map<string, PerfRow[]>();
  for (const p of (allPerfs ?? []) as PerfRow[]) {
    const list = perfsByHorseId.get(p.horse_id) ?? [];
    list.push(p);
    perfsByHorseId.set(p.horse_id, list);
  }

  for (const horse of topHorses) {
    const header = [
      `HORSE: ${horse.name}`,
      horse.sex ? `(${horse.sex})` : null,
      horse.age ? `Age ${horse.age}` : null,
    ].filter(Boolean).join(" ");
    lines.push(header);

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
      // Sort by race_date descending client-side
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

  // Connections stats for all trainers/jockeys in the result set
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

  return lines.join("\n");
}

export async function POST(request: Request) {
  // ── Startup env checks ──────────────────────────────────────────────────────
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

    // ── Shared community intelligence (Rule D) ─────────────────────────────────
    // relevantCommunityContext — query-relevant posts at 300 chars (gate check + no-schema Claude input)
    // cappedCommunityContext   — top 3 query-relevant posts at 200 chars (schema-present Claude input)
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

        // Relevance filter — minimum match term length of 6 chars to exclude generic
        // words like "Derby" (5), "Race" (4), "Stakes" (6 — borderline, kept for specificity).
        // This prevents posts about Arkansas Derby bleeding into Wood Memorial queries.
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
          // Schema-present cap: 3 most relevant posts at 200 chars each — schema data dominates
          cappedCommunityContext = COMMUNITY_HEADER + relevantPosts.slice(0, 3).map((p) => makeEntry(p, 200)).join("\n\n");
        }

        console.log("[brain] community posts — total:", sharedPosts.length, "| relevant to query:", relevantPosts.length);
      }
    } catch (err) {
      const e = err as Error & { cause?: unknown };
      console.error("[brain] community posts failed:", e?.message);
      if (e?.cause) console.error("[brain] community posts cause:", e.cause);
    }

    // ── Auth ───────────────────────────────────────────────────────────────────
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

    // ── Schema context (primary knowledge source) ─────────────────────────────
    let schemaContext = "";
    if (userId) {
      try {
        schemaContext = await buildSchemaContext(userId, user_message ?? "", admin);
        console.log("[brain] final schema context chars:", schemaContext.length);
      } catch (err) {
        console.error("[brain] schema context query failed:", (err as Error).message);
      }
    }

    // ── Resolve conversation ───────────────────────────────────────────────────
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

    // ── Save user message (fire-and-forget) ────────────────────────────────────
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

    // ── Build system prompt ────────────────────────────────────────────────────
    // Brain Knowledge Base (highest trust) + Community Intelligence (second tier).
    // When schema is present: cap at 3 relevant posts at 200 chars — schema dominates.
    // When schema is absent: full relevant post list at 300 chars.
    const contextParts: string[] = [BASE_PROMPT];
    if (schemaContext) contextParts.push(schemaContext);
    const communityForClaude = schemaContext ? cappedCommunityContext : relevantCommunityContext;
    if (communityForClaude) {
      contextParts.push(communityForClaude);
    }

    const systemPrompt = contextParts.join("\n\n");

    // ── Validate and trim message list ────────────────────────────────────────
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

    // ── Stream ─────────────────────────────────────────────────────────────────
    const model = "claude-sonnet-4-6";
    console.log("[brain] prompt budget — system:", systemPrompt.length, "chars | schema:", schemaContext.length, "chars | community:", sharedIntelligenceContext.length, "chars | messages:", anthropicMessages.length);

    let stream: AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>;
    try {
      stream = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: anthropicMessages,
        tools: [{ type: "web_search_20250305" as const, name: "web_search" }],
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

    // Capture for closure
    const capturedUserId = userId;
    const capturedConvId = activeConvId;

    const readableStream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let fullText = "";
        try {
          for await (const chunk of stream) {
            // Only forward text deltas to the client.
            // Skip input_json_delta (tool call arguments) and all other non-text events.
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

        // ── Persist assistant message + bump conversation updated_at ───────────
        // fullText contains only accumulated text_delta content — tool_use blocks
        // are never included, so it is always safe to insert as a plain string.
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
