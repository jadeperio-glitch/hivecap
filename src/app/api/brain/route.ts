import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BASE_PROMPT = `You are the HiveCap Brain — an expert horse racing analyst. You specialize in:
- Beyer Speed Figures and pace analysis
- Pedigree research and trip notes
- Wagering strategy (exactas, trifectas, Pick 4/5/6)
- The 2026 Kentucky Derby field and contenders
- Track bias, trainer patterns, and jockey statistics

You synthesize and analyze information from your training data. You never reproduce copyrighted content verbatim — you always analyze, summarize, and provide original insights. You are precise, confident, and data-driven. When discussing horses, lead with the most analytically relevant factors.`;

const GROUNDING_INSTRUCTION = `DATA GROUNDING RULE:
You have been provided with structured racing data extracted from documents the user has uploaded. This is your PRIMARY and ONLY source for specific horse and race facts.
- Discuss ONLY the horses and races present in the Brain Knowledge Base section below.
- If asked about a horse or race that is NOT listed there, respond exactly: "I don't have data on this in your Brain. Upload a past performance or check if another user has posted analysis on this race."
- Do NOT fill gaps with general training knowledge about specific horses, their real-world records, or race results outside the provided data. No guessing, no approximations.
- Community Intelligence posts are supplementary context only — defer to the extracted Knowledge Base when there is any conflict.`;

const NO_DATA_INSTRUCTION = `DATA GROUNDING RULE:
No structured racing data has been extracted into your Brain yet.
- You may answer general questions about handicapping methodology, wagering strategy, racing concepts, and track bias.
- For any question about a specific horse, race, speed figure, result, or performance: respond exactly: "I don't have data on this in your Brain. Upload a past performance or check if another user has posted analysis on this race." Do NOT draw on general training knowledge to answer specific factual questions about horses or races.`;

const DOCUMENT_INSTRUCTION =
  "You have access to documents uploaded by the user. Extract and reason from the data within them but never reproduce source text verbatim. All answers must be derivative analysis only.";

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

  const matches = query.matchAll(/\b([A-Z][a-zA-Z']+(?:\s+[A-Z][a-zA-Z']+){0,3})\b/g);
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

  // Fetch horses uploaded by this user (most recent 15)
  const { data: ownHorses } = await admin
    .from("horses")
    .select("id, name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, notes")
    .eq("uploaded_by", userId)
    .order("created_at", { ascending: false })
    .limit(15);

  // Additionally search by name terms from the query
  const termMatches: NonNullable<typeof ownHorses> = [];
  for (const term of terms.slice(0, 4)) {
    const { data } = await admin
      .from("horses")
      .select("id, name, sire, dam, dam_sire, trainer, jockey, owner, age, sex, notes")
      .ilike("name", `%${term}%`)
      .limit(5);
    if (data) termMatches.push(...data);
  }

  // Merge and dedup by id
  const seen = new Set<string>();
  const horses = [...(ownHorses ?? []), ...termMatches].filter((h) => {
    if (seen.has(h.id)) return false;
    seen.add(h.id);
    return true;
  });

  if (horses.length === 0) return "";

  const lines: string[] = [
    "--- Brain Knowledge Base — Extracted Racing Data ---",
    "",
  ];

  for (const horse of horses.slice(0, 15)) {
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

    // Performance records with race + track context
    const { data: perfs } = await admin
      .from("performance")
      .select(`
        finish_position, lengths_beaten,
        beyer_figure, beyer_source,
        equibase_speed_fig, equibase_source,
        timeform_rating, timeform_source,
        final_time, running_style, weight_carried, odds,
        trip_notes, trouble_line,
        races (
          race_date, race_number, distance, surface, condition, class_level, purse,
          tracks ( name, abbreviation )
        )
      `)
      .eq("horse_id", horse.id)
      .limit(8);

    if (perfs && perfs.length > 0) {
      // Sort by race_date descending client-side
      const sorted = [...perfs]
        .sort((a, b) => {
          const da = (a.races as { race_date?: string } | null)?.race_date ?? "";
          const db = (b.races as { race_date?: string } | null)?.race_date ?? "";
          return db.localeCompare(da);
        })
        .slice(0, 5);

      lines.push("  Performance:");
      for (const p of sorted) {
        const race = p.races as {
          race_date?: string; race_number?: number; distance?: string;
          surface?: string; condition?: string; class_level?: string; purse?: number;
          tracks?: { name?: string; abbreviation?: string } | null;
        } | null;
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
  const trainerNames = [...new Set(horses.map((h) => h.trainer).filter((n): n is string => !!n))];
  const jockeyNames = [...new Set(horses.map((h) => h.jockey).filter((n): n is string => !!n))];
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
    let sharedIntelligenceContext = "";
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
        const POST_MAX = 300;
        const entries = sharedPosts
          .map((p) => {
            const author = p.username ?? p.user_email;
            const date = new Date(p.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
            const body = p.content.length > POST_MAX ? p.content.slice(0, POST_MAX) + "…" : p.content;
            return `[${author} · ${date}]\n${body}`;
          })
          .join("\n\n");
        sharedIntelligenceContext =
          `--- Community Intelligence — publicly shared findings from HiveCap users ---\n` +
          `The following posts were verified by the Brain and shared by the community. ` +
          `Treat them as supplementary analyst notes — useful signal, but defer to the ` +
          `extracted Knowledge Base and the user's own analysis when they conflict.\n\n` +
          entries;
        console.log("[brain] loaded shared community posts:", sharedPosts.length);
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
    // Query horses/races/performance/connections for this user.
    // Falls back to user_documents if schema returns no results.
    let schemaContext = "";
    let documentContext = "";

    if (userId) {
      try {
        schemaContext = await buildSchemaContext(userId, user_message ?? "", admin);
        console.log("[brain] schema context chars:", schemaContext.length, "| horses found:", schemaContext ? "yes" : "none");
      } catch (err) {
        console.error("[brain] schema context query failed:", (err as Error).message);
      }

      // ── user_documents fallback (only if schema returned nothing) ─────────────
      if (!schemaContext) {
        try {
          const supabase = createClient();
          const { data: docs, error: docsErr } = await supabase
            .from("user_documents")
            .select("filename, extracted_text")
            .eq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(5);

          if (docsErr) {
            console.error("[brain] user documents failed:", docsErr.message, "| code:", docsErr.code);
          } else if (docs && docs.length > 0) {
            const DOC_TOTAL_BUDGET = 40000;
            const charsPerDoc = Math.floor(DOC_TOTAL_BUDGET / docs.length);
            documentContext = docs
              .map((d) => {
                const text = d.extracted_text.length > charsPerDoc
                  ? d.extracted_text.slice(0, charsPerDoc) + "…"
                  : d.extracted_text;
                return `--- Document: ${d.filename} ---\n${text}`;
              })
              .join("\n\n");
            console.log("[brain] schema empty — loaded user_documents fallback:", docs.length, "docs");
          } else {
            console.log("[brain] no schema data and no user documents found");
          }
        } catch (err) {
          const e = err as Error & { cause?: unknown };
          console.error("[brain] user documents threw:", e?.message);
          if (e?.cause) console.error("[brain] user documents cause:", e.cause);
        }
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
    // Order: base persona → grounding rule + schema → community intel → fallback docs
    const contextParts: string[] = [BASE_PROMPT];

    if (schemaContext) {
      contextParts.push(GROUNDING_INSTRUCTION);
      contextParts.push(schemaContext);
    } else if (documentContext) {
      contextParts.push(
        `--- Personal Documents — uploaded by this user (higher priority than community posts) ---\n` +
        documentContext
      );
      contextParts.push(DOCUMENT_INSTRUCTION);
    } else {
      contextParts.push(NO_DATA_INSTRUCTION);
    }

    if (sharedIntelligenceContext) {
      contextParts.push(sharedIntelligenceContext);
    }

    const systemPrompt = contextParts.join("\n\n");

    // ── Validate and trim message list ────────────────────────────────────────
    const anthropicMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
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
    const model = "claude-sonnet-4-5";
    console.log("[brain] prompt budget — system:", systemPrompt.length, "chars | schema:", schemaContext.length, "chars | community:", sharedIntelligenceContext.length, "chars | docs:", documentContext.length, "chars | messages:", anthropicMessages.length);

    let stream: AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>;
    try {
      stream = await client.messages.create({
        model,
        max_tokens: 2048,
        system: systemPrompt,
        messages: anthropicMessages,
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
            if (
              chunk.type === "content_block_delta" &&
              chunk.delta?.type === "text_delta" &&
              chunk.delta.text
            ) {
              fullText += chunk.delta.text;
              controller.enqueue(encoder.encode(chunk.delta.text));
            }
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
