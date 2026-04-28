import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Source priority — higher number = higher trust. Lower trust never overwrites.
// ─────────────────────────────────────────────────────────────────────────────
const SOURCE_PRIORITY: Record<string, number> = {
  equibase: 5,
  drf: 4,
  racing_api: 3,
  user_upload: 2,
  community: 1,
};

function sourcePriority(source: string | null | undefined): number {
  return SOURCE_PRIORITY[source ?? ""] ?? 0;
}

/**
 * Strips parenthetical content (e.g. "(Curlin)") for merge comparison only.
 * Raw values are still written to columns unchanged.
 */
function normalizePedigree(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/\s*\(.*?\)\s*/g, '').trim().toLowerCase();
}

function normalizeName(value: string | null | undefined): string {
  if (!value) return '';
  return value.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Primary extraction prompt (Step 3, race_index = 1 or first user selection)
// ─────────────────────────────────────────────────────────────────────────────
const PRIMARY_SYSTEM = `You are the HiveCap Brain ingestion engine. Extract structured data from a horse racing document and return a clean JSON object.

EXTRACTION ORDER:
1. Identify the race context first (track, date, race number, distance, surface, condition, class, purse)
2. Then extract each horse within that race context (name, connections, figures, fractions, finish, trip notes)
3. Then extract narrative content (trainer quotes, barn notes, trip notes) into notes fields

FOR PAST PERFORMANCE SHEETS:
- The document shows an upcoming race entry at the top, followed by each horse's prior race history (PP lines)
- Extract the upcoming race context (track, date, distance, surface, class) as the race record
- For each horse, ALSO extract their most recent prior race performance from the PP history lines below their entry — this includes: Beyer figure, fractional splits, finish position, final time, running style, trip notes from their last start
- Store the prior race performance as a separate performance record linked to the horse — use the date, track, and race details from that PP line as the race context
- Never leave Beyer figures, fractions, or finish positions null if they appear anywhere in the document for that horse

DOCUMENT TYPE DETECTION:
- If this is a past performance sheet: follow full extraction protocol
- If this is a result chart, race card, clocker report, or workout tab: extract what maps to the schema, flag document_type in response
- If document type cannot be determined: return { "status": "unrecognized", "notes": "<describe what you see>" }

RETURN this exact JSON structure:
{
  "status": "success" | "partial" | "unrecognized" | "race_not_found",
  "document_type": "past_performance" | "result_chart" | "race_card" | "clocker_report" | "workout_tab",
  "race": {
    "track_name": "<string>",
    "track_abbreviation": "<string>",
    "race_date": "<YYYY-MM-DD>",
    "race_number": <integer>,
    "race_name": "<string or null>",
    "distance": "<string>",
    "surface": "dirt" | "turf" | "synthetic",
    "condition": "fast" | "good" | "yielding" | "soft" | "firm" | "sloppy" | "muddy",
    "purse": <integer or null>,
    "class_level": "G1" | "G2" | "G3" | "Stakes" | "Allowance" | "Claiming" | "Maiden",
    "claiming_price": <integer or null>,
    "field_size": <integer or null>,
    "notes": "<race recap, stewards notes — narrative only>"
  },
  "horses": [
    {
      "name": "<string>",
      "sire": "<string or null>",
      "dam": "<string or null>",
      "dam_sire": "<string or null>",
      "trainer": "<string or null>",
      "jockey": "<string or null>",
      "owner": "<string or null>",
      "age": <integer or null>,
      "sex": "C" | "F" | "G" | "M" | "H" | "R" | null,
      "notes": "<trainer quotes, barn notes — narrative only>",
      "performance": {
        "post_position": <integer or null>,
        "finish_position": <integer or null>,
        "lengths_beaten": <decimal or null>,
        "beyer_figure": <integer or null>,
        "beyer_source": "DRF" | "user_upload" | null,
        "equibase_speed_fig": <integer or null>,
        "equibase_source": "<string or null>",
        "timeform_rating": <integer or null>,
        "timeform_source": "<string or null>",
        "frac_quarter": "<string e.g. ':22.65' or null>",
        "frac_quarter_sec": <decimal or null>,
        "frac_half": "<string or null>",
        "frac_half_sec": <decimal or null>,
        "frac_three_quarters": "<string or null>",
        "frac_three_quarters_sec": <decimal or null>,
        "final_time": "<string or null>",
        "final_time_sec": <decimal or null>,
        "running_style": "E" | "EP" | "PS" | "C" | "S" | null,
        "weight_carried": <integer or null>,
        "odds": <decimal or null>,
        "trip_notes": "<verbatim narrative or null>",
        "trouble_line": "<verbatim or null>"
      }
    }
  ],
  "extraction_flags": [
    { "field": "<field_name>", "note": "<reason>" }
  ]
}

HARD RULES:
- Never hallucinate a value. If a field is not clearly present, return null for numbers, null for strings.
- Never zero-fill. A Beyer of 0 is not the same as a missing Beyer. Missing = null + flag in extraction_flags.
- Never blend figures from different sources. Each figure gets its own source label.
- Fractions: always populate both string and decimal versions if present. String preserves original formatting. Decimal strips to numeric only. Example: ":22.65" → frac_quarter = ":22.65", frac_quarter_sec = 22.65
- trip_notes and trouble_line are narrative — capture verbatim from the document.
- notes fields are for narrative overflow only. Do not put structured data in notes.
- If the document contains multiple races for the same horse (full PP history), extract the MOST RECENT race as the primary record and note additional races in extraction_flags.
- For workout tabs or workout sections within a PP sheet: extract the 3 most recent workouts only. Ignore all earlier workout entries.
- MORNING LINE ODDS — CRITICAL:
  - Morning line odds on a PP sheet appear in a dedicated column, typically labeled 'ML' or 'Morn Line'
  - They are expressed as: 5-1, 12-1, 30-1, 9-5, 7-2, even (meaning 1-1)
  - Read the EXACT number from the ML column for each horse — do not calculate or derive it
  - Convert to decimal:
    - 5-1 → 5.0
    - 12-1 → 12.0
    - 30-1 → 30.0
    - 9-5 → 1.8
    - 7-2 → 3.5
    - even → 1.0
    - 1-2 → 0.5
  - The favorite has the LOWEST odds number
  - Longshots have HIGH odds numbers (20+)
  - NEVER return odds below 0.5 unless the horse is a prohibitive favorite
  - If you cannot clearly identify the ML column, return null for all odds and add extraction_flag: 'ml_column_not_found'

Return only the JSON object. No preamble, no explanation, no markdown fences.`;

// ─────────────────────────────────────────────────────────────────────────────
// Multi-race follow-up prompt (Step 3, race_index > 1)
// ─────────────────────────────────────────────────────────────────────────────
function buildFollowUpSystem(
  raceIndex: number,
  totalRaces: number,
  horseName: string,
  sire: string,
  dam: string,
): string {
  return `You are the HiveCap Brain ingestion engine processing one race from a multi-race document.

YOUR TASK:
Extract data for race ${raceIndex} of ${totalRaces} from this document.
Use the same extraction protocol as the primary pass but target only this specific race.

RACE TARGETING:
- Documents are ordered chronologically — most recent race first
- Race 1 = most recent, Race ${totalRaces} = oldest
- Focus exclusively on race ${raceIndex}
- Do not extract data from any other race in the document
- If race ${raceIndex} cannot be clearly identified, return:
  { "status": "race_not_found", "race_index": ${raceIndex}, "notes": "<describe what you see at this position>" }

CONTEXT FROM PRIMARY PASS:
Horse name: ${horseName}
Sire: ${sire}
Dam: ${dam}
Use this to confirm you are extracting the correct horse.
If the horse at race ${raceIndex} does not match, flag it:
{ "field": "horse_mismatch", "reason": "Horse at race ${raceIndex} does not match ${horseName}" }

Apply all hard rules from the primary extraction protocol. Return the same JSON structure.
Return only the JSON object. No preamble, no explanation, no markdown fences.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types for the extraction response
// ─────────────────────────────────────────────────────────────────────────────
interface ExtractedPerformance {
  post_position: number | null;
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
  final_time_sec: number | null;
  running_style: string | null;
  weight_carried: number | null;
  odds: number | null;
  trip_notes: string | null;
  trouble_line: string | null;
}

interface ExtractedHorse {
  name: string;
  sire: string | null;
  dam: string | null;
  dam_sire: string | null;
  trainer: string | null;
  jockey: string | null;
  owner: string | null;
  age: number | null;
  sex: string | null;
  notes: string | null;
  performance: ExtractedPerformance;
}

interface ExtractedRace {
  track_name: string;
  track_abbreviation: string | null;
  race_date: string;
  race_number: number;
  race_name: string | null;
  distance: string | null;
  surface: string | null;
  condition: string | null;
  purse: number | null;
  class_level: string | null;
  claiming_price: number | null;
  field_size: number | null;
  notes: string | null;
}

interface ExtractionResult {
  status: string;
  document_type?: string;
  race?: ExtractedRace;
  horses?: ExtractedHorse[];
  extraction_flags?: Array<{ field: string; note?: string; reason?: string }>;
  notes?: string;
}

function isValidExtraction(obj: unknown): obj is ExtractionResult {
  if (!obj || typeof obj !== "object") return false;
  const r = obj as Record<string, unknown>;
  if (typeof r.status !== "string") return false;
  if (r.status === "success" || r.status === "partial") {
    if (!r.race || typeof r.race !== "object") return false;
    if (!Array.isArray(r.horses)) return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/ingest/extract
// Body: { pending_document_id: string, race_index: number }
// Steps 3–10 for one race.
// ─────────────────────────────────────────────────────────────────────────────
export async function POST(request: Request) {
  console.log("[ingest/extract] env check — admin ids:", process.env.HIVECAP_ADMIN_USER_IDS ?? "NOT SET");
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const supabase = createClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ── Admin check ───────────────────────────────────────────────────────────
    const adminIds = (process.env.HIVECAP_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const isAdmin = adminIds.includes(user.id);
    const brainLayer = isAdmin ? "shared" : "personal";
    console.log("[ingest/extract] user:", user.id, "| admin:", isAdmin, "| brain_layer:", brainLayer);

    // ── Parse body ────────────────────────────────────────────────────────────
    let body: { pending_document_id?: string; race_index?: number };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const { pending_document_id, race_index } = body;
    if (!pending_document_id || typeof race_index !== "number") {
      return json({ error: "pending_document_id and race_index are required" }, 400);
    }

    const admin = createAdminClient();

    // ── Fetch pending_document ────────────────────────────────────────────────
    const { data: pendingDoc, error: pendingErr } = await admin
      .from("pending_documents")
      .select("*")
      .eq("id", pending_document_id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (pendingErr || !pendingDoc) {
      return json({ error: "Pending document not found" }, 404);
    }

    if (new Date(pendingDoc.expires_at) < new Date()) {
      return json({ error: "This document has expired. Please re-upload." }, 410);
    }

    if ((pendingDoc.races_extracted as number[]).includes(race_index)) {
      return json({
        status: "duplicate",
        message: `Race ${race_index} has already been extracted for this document.`,
      });
    }

    if (!(pendingDoc.races_pending as number[]).includes(race_index)) {
      return json({ error: `Race ${race_index} is not in the pending queue for this document.` }, 400);
    }

    // ── Download extracted text from storage ──────────────────────────────────
    const { data: storageData, error: storageErr } = await admin.storage
      .from("brain-ingestion")
      .download(pendingDoc.storage_ref);

    if (storageErr || !storageData) {
      console.error("[ingest/extract] storage download error:", storageErr);
      return json({ error: "Could not retrieve document for extraction. It may have expired." }, 500);
    }

    const extractedText = await storageData.text();

    // ── Determine extraction prompt (primary vs follow-up) ────────────────────
    // If race_index === 1 OR no prior horse context exists, use primary prompt.
    // Otherwise, look up the primary horse from prior extractions on this hash.
    let systemPrompt = PRIMARY_SYSTEM;

    if (race_index > 1) {
      const { data: priorLog } = await admin
        .from("ingestion_log")
        .select("horse_id")
        .eq("pdf_hash", pendingDoc.pdf_hash)
        .eq("user_id", user.id)
        .eq("status", "success")
        .not("horse_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (priorLog?.horse_id) {
        const { data: priorHorse } = await admin
          .from("horses")
          .select("name, sire, dam")
          .eq("id", priorLog.horse_id)
          .maybeSingle();

        if (priorHorse) {
          systemPrompt = buildFollowUpSystem(
            race_index,
            pendingDoc.total_races,
            priorHorse.name ?? "",
            priorHorse.sire ?? "",
            priorHorse.dam ?? "",
          );
        }
      }
    }

    // ── Step 3: Claude extraction call ────────────────────────────────────────
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const textLimit = extractedText.length;
    console.log("[ingest/extract] text length:", extractedText.length, "| sending:", textLimit, "chars");

    let extraction: ExtractionResult;
    try {
      const extractResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `Extract race ${race_index} of ${pendingDoc.total_races} from this document:\n\n${extractedText.slice(0, textLimit)}`,
          },
        ],
      });

      if (extractResponse.stop_reason === "max_tokens") {
        throw new Error("max_tokens_exceeded");
      }

      const raw = extractResponse.content[0].type === "text"
        ? extractResponse.content[0].text.trim()
        : "";

      console.log("[ingest/extract] raw Claude response:", raw);

      // Strip markdown fences — handles leading/trailing fences, newlines before
      // the opening fence, and any trailing text after the closing fence.
      let cleaned = raw;
      const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenceMatch) {
        cleaned = fenceMatch[1].trim();
      } else {
        cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      }

      console.log("[ingest/extract] cleaned for parse:", cleaned);

      const parsed = JSON.parse(cleaned);

      if (!isValidExtraction(parsed)) {
        throw new Error("Response failed structure validation");
      }
      extraction = parsed;
    } catch (extractErr) {
      console.error("[ingest/extract] extraction call error:", extractErr);

      const isTokenLimit = extractErr instanceof Error && extractErr.message === "max_tokens_exceeded";
      const errorNote = isTokenLimit
        ? `max_tokens exceeded for race ${race_index}`
        : `Extraction parse error for race ${race_index}: ${extractErr instanceof Error ? extractErr.message : String(extractErr)}`;

      // Log failure
      await admin.from("ingestion_log").insert({
        user_id: user.id,
        source: "upload",
        source_ref: pendingDoc.pdf_hash,
        pdf_hash: pendingDoc.pdf_hash,
        status: "failed",
        notes: errorNote,
      });

      await admin.from("ingestion_jobs").update({
        status: "failed",
        error_notes: errorNote,
      }).eq("pdf_hash", pendingDoc.pdf_hash).eq("race_index", race_index).eq("user_id", user.id);

      return json({
        status: "failed",
        message: isTokenLimit
          ? "Extraction incomplete — document may be too large. Try uploading a single race page."
          : `We couldn't process race ${race_index}. The response from the AI was malformed. Please try again.`,
      });
    }

    // Diagnostic: log raw odds from Claude before any validation or DB writes
    console.log("[ingest/extract] raw odds from Claude:",
      extraction.horses?.map((h) => ({ name: h.name, odds: h.performance?.odds }))
    );

    // Handle unrecognized / race_not_found statuses
    if (extraction.status === "unrecognized") {
      return json({ status: "unrecognized", message: `Unrecognized document. ${extraction.notes ?? ""}` }, 422);
    }
    if (extraction.status === "race_not_found") {
      return json({ status: "race_not_found", message: `Race ${race_index} could not be clearly identified in the document.` });
    }

    if (!extraction.race || !extraction.horses || extraction.horses.length === 0) {
      return json({ status: "failed", message: `No race or horse data found in race ${race_index}.` });
    }

    const raceData = extraction.race;
    const flags = extraction.extraction_flags ?? [];

    // ── Step 4: Race resolution ───────────────────────────────────────────────
    // Match on track + race_date + race_number. Insert track if needed.
    let trackId: string | null = null;

    if (raceData.track_name) {
      const { data: existingTrack } = await admin
        .from("tracks")
        .select("id")
        .ilike("name", raceData.track_name)
        .maybeSingle();

      if (existingTrack) {
        trackId = existingTrack.id;
      } else {
        const { data: newTrack } = await admin
          .from("tracks")
          .insert({
            name: raceData.track_name,
            abbreviation: raceData.track_abbreviation ?? null,
          })
          .select("id")
          .single();
        trackId = newTrack?.id ?? null;
      }
    }

    let raceId: string | null = null;

    if (raceData.race_date && raceData.race_number) {
      // Look for existing race: same track + date + race_number
      const raceQuery = admin
        .from("races")
        .select("id")
        .eq("race_date", raceData.race_date)
        .eq("race_number", raceData.race_number);

      if (trackId) raceQuery.eq("track_id", trackId);

      const { data: existingRace } = await raceQuery.maybeSingle();

      if (existingRace) {
        raceId = existingRace.id;
      } else {
        const { data: newRace } = await admin
          .from("races")
          .insert({
            track_id: trackId,
            race_date: raceData.race_date,
            race_number: raceData.race_number,
            race_name: raceData.race_name ?? null,
            distance: raceData.distance ?? null,
            surface: raceData.surface ?? null,
            condition: raceData.condition ?? null,
            purse: raceData.purse ?? null,
            class_level: raceData.class_level ?? null,
            claiming_price: raceData.claiming_price ?? null,
            field_size: raceData.field_size ?? null,
            notes: raceData.notes ?? null,
            source: "user_upload",
          })
          .select("id")
          .single();
        raceId = newRace?.id ?? null;
      }
    }

    // ── Steps 5–7: Horse resolution + performance write + connections ─────────
    const results: Array<{ horse_name: string; horse_id: string | null; status: string }> = [];
    let primaryHorseId: string | null = null;

    for (const horseData of extraction.horses) {
      if (!horseData.name) continue;

      // ── Step 5: Horse resolution ──────────────────────────────────────────
      // Scope: user's own rows + all shared/gated rows.
      // Branch B: non-admin uploads resolve into existing shared rows — no personal duplicates.
      const { data: candidateHorses } = await admin
        .from("horses")
        .select("id, name, sire, dam, merge_confirmed, canonical_source, source, brain_layer, uploaded_by")
        .or(`uploaded_by.eq.${user.id},brain_layer.in.(shared,gated)`);

      const normalizedIncomingName = normalizeName(horseData.name);
      const normalizedIncomingSire = normalizePedigree(horseData.sire);
      const normalizedIncomingDam = normalizePedigree(horseData.dam);

      // Filter in code: normalize name first, then evaluate pedigree per rule below
      const nameFilteredMatches = (candidateHorses ?? []).filter(
        (h) => normalizeName(h.name) === normalizedIncomingName
      );

      let horseId: string | null = null;
      let mergeConfirmed = false;

      if (nameFilteredMatches.length > 0) {
        // Rule 1: all four pedigree values present and both match → confirmed merge
        const confirmedMatch = nameFilteredMatches.find((h) => {
          const esSire = normalizePedigree(h.sire);
          const esDam = normalizePedigree(h.dam);
          return normalizedIncomingSire && normalizedIncomingDam && esSire && esDam &&
            esSire === normalizedIncomingSire && esDam === normalizedIncomingDam;
        });

        if (confirmedMatch) {
          horseId = confirmedMatch.id;
          mergeConfirmed = true;

          const incomingPriority = sourcePriority("user_upload");
          const existingPriority = sourcePriority(confirmedMatch.source);

          if (incomingPriority > existingPriority) {
            await admin.from("horses").update({
              merge_confirmed: true,
              canonical_source: "user_upload",
              source: "user_upload",
              trainer: horseData.trainer ?? undefined,
              jockey: horseData.jockey ?? undefined,
              // Admin upload promotes personal rows to shared Brain layer
              ...(isAdmin && confirmedMatch.brain_layer === "personal" ? { brain_layer: "shared" } : {}),
            }).eq("id", horseId);
          } else {
            await admin.from("horses").update({
              merge_confirmed: true,
              ...(isAdmin && confirmedMatch.brain_layer === "personal" ? { brain_layer: "shared" } : {}),
            }).eq("id", horseId);
          }
        } else {
          // Rule 3: name match where both sides have values but at least one pedigree field differs
          const conflictMatch = nameFilteredMatches.find((h) => {
            const esSire = normalizePedigree(h.sire);
            const esDam = normalizePedigree(h.dam);
            const sireConflict = normalizedIncomingSire && esSire && esSire !== normalizedIncomingSire;
            const damConflict = normalizedIncomingDam && esDam && esDam !== normalizedIncomingDam;
            return sireConflict || damConflict;
          });

          if (conflictMatch) {
            // Rule 3: pedigree conflict → new row + log
            flags.push({
              field: "horse_pedigree_conflict",
              note: `pedigree_conflict: name="${horseData.name}" existing_sire="${conflictMatch.sire ?? ''}" incoming_sire="${horseData.sire ?? ''}" existing_dam="${conflictMatch.dam ?? ''}" incoming_dam="${horseData.dam ?? ''}"`,
            });
          } else if (!normalizedIncomingSire || !normalizedIncomingDam) {
            // Rule 4: incoming pedigree null/empty
            // Rule 4a: if a shared/gated+confirmed candidate has full pedigree, reuse it
            const sharedConfirmedCandidate = nameFilteredMatches.find((h) =>
              (h.brain_layer === "shared" || h.brain_layer === "gated") &&
              h.merge_confirmed === true &&
              !!h.sire && !!h.dam
            );

            if (sharedConfirmedCandidate) {
              // Rule 4a: reuse confirmed shared horse — do not update its pedigree with null incoming
              horseId = sharedConfirmedCandidate.id;
              mergeConfirmed = true;
              flags.push({
                field: "horse_pedigree_inferred_from_shared",
                note: `pedigree_inferred_from_shared: name="${horseData.name}" used_horse_id="${sharedConfirmedCandidate.id}" reason="incoming_extraction_lacked_pedigree"`,
              });
              if (isAdmin && sharedConfirmedCandidate.brain_layer === "personal") {
                await admin.from("horses").update({ brain_layer: "shared" }).eq("id", horseId);
              }
            } else {
              // Rule 4b: no confirmed shared candidate → insert new row
              flags.push({
                field: "horse_pedigree_incomplete",
                note: `pedigree_incomplete: name="${horseData.name}"`,
              });
            }
          } else {
            // Incoming has pedigree but candidate pedigree is null — treat as incomplete (per spec)
            flags.push({
              field: "horse_pedigree_incomplete",
              note: `pedigree_incomplete: name="${horseData.name}"`,
            });
          }
          // horseId remains null → insert new row below (Rules 3, 4b, candidate-null cases)
        }
      }

      if (!horseId) {
        // Rule 1 (no name match) or Rules 3/4 (conflict/incomplete) → insert new row
        const { data: newHorse } = await admin
          .from("horses")
          .insert({
            name: horseData.name,
            sire: horseData.sire ?? null,   // raw value preserved — no paren stripping
            dam: horseData.dam ?? null,     // raw value preserved — no paren stripping
            dam_sire: horseData.dam_sire ?? null,
            trainer: horseData.trainer ?? null,
            jockey: horseData.jockey ?? null,
            owner: horseData.owner ?? null,
            age: horseData.age ?? null,
            sex: horseData.sex ?? null,
            notes: horseData.notes ?? null,
            merge_confirmed: false,
            source: "user_upload",
            canonical_source: "user_upload",
            brain_layer: brainLayer,
            uploaded_by: user.id,
          })
          .select("id")
          .single();
        horseId = newHorse?.id ?? null;
      }

      if (!primaryHorseId) primaryHorseId = horseId;

      // ── Step 6: Performance write ───────────────────────────────────────────
      if (horseId && raceId) {
        const { data: existingPerf } = await admin
          .from("performance")
          .select("id, source")
          .eq("horse_id", horseId)
          .eq("race_id", raceId)
          .maybeSingle();

        const perf = horseData.performance;

        // Validate odds — any value below 0.5 is a parsing error (e.g. 12-1 misread as 1/2).
        // Null it out and flag rather than writing bad data to the schema.
        if (perf.odds !== null && perf.odds !== undefined && perf.odds < 0.5) {
          flags.push({
            field: "odds_suspicious",
            note: `Odds value ${perf.odds} is below 0.5 — likely a parsing error (fractional odds misread). Set to null.`,
          });
          perf.odds = null;
        }

        if (existingPerf) {
          const existingPriority = sourcePriority(existingPerf.source);
          const incomingPriority = sourcePriority("user_upload");

          if (incomingPriority > existingPriority) {
            // Incoming has higher trust — overwrite
            await admin.from("performance").update({
              post_position: perf.post_position ?? null,
              finish_position: perf.finish_position ?? null,
              lengths_beaten: perf.lengths_beaten ?? null,
              beyer_figure: perf.beyer_figure ?? null,
              beyer_source: perf.beyer_source ?? null,
              equibase_speed_fig: perf.equibase_speed_fig ?? null,
              equibase_source: perf.equibase_source ?? null,
              timeform_rating: perf.timeform_rating ?? null,
              timeform_source: perf.timeform_source ?? null,
              frac_quarter: perf.frac_quarter ?? null,
              frac_quarter_sec: perf.frac_quarter_sec ?? null,
              frac_half: perf.frac_half ?? null,
              frac_half_sec: perf.frac_half_sec ?? null,
              frac_three_quarters: perf.frac_three_quarters ?? null,
              frac_three_quarters_sec: perf.frac_three_quarters_sec ?? null,
              final_time: perf.final_time ?? null,
              final_time_sec: perf.final_time_sec ?? null,
              running_style: perf.running_style ?? null,
              weight_carried: perf.weight_carried ?? null,
              odds: perf.odds ?? null,
              trip_notes: perf.trip_notes ?? null,
              trouble_line: perf.trouble_line ?? null,
              source: "user_upload",
              uploaded_by: user.id,
              brain_layer: brainLayer,
            }).eq("id", existingPerf.id);
          } else {
            // Lower trust — log but don't overwrite
            flags.push({
              field: "performance_skip",
              note: `performance_skip: lower_priority_source — existing: ${existingPerf.source}, incoming: user_upload`,
            });
          }
        } else {
          // No existing row — insert
          await admin.from("performance").insert({
            horse_id: horseId,
            race_id: raceId,
            post_position: perf.post_position ?? null,
            finish_position: perf.finish_position ?? null,
            lengths_beaten: perf.lengths_beaten ?? null,
            beyer_figure: perf.beyer_figure ?? null,
            beyer_source: perf.beyer_source ?? null,
            equibase_speed_fig: perf.equibase_speed_fig ?? null,
            equibase_source: perf.equibase_source ?? null,
            timeform_rating: perf.timeform_rating ?? null,
            timeform_source: perf.timeform_source ?? null,
            frac_quarter: perf.frac_quarter ?? null,
            frac_quarter_sec: perf.frac_quarter_sec ?? null,
            frac_half: perf.frac_half ?? null,
            frac_half_sec: perf.frac_half_sec ?? null,
            frac_three_quarters: perf.frac_three_quarters ?? null,
            frac_three_quarters_sec: perf.frac_three_quarters_sec ?? null,
            final_time: perf.final_time ?? null,
            final_time_sec: perf.final_time_sec ?? null,
            running_style: perf.running_style ?? null,
            weight_carried: perf.weight_carried ?? null,
            odds: perf.odds ?? null,
            trip_notes: perf.trip_notes ?? null,
            trouble_line: perf.trouble_line ?? null,
            brain_layer: brainLayer,
            uploaded_by: user.id,
            source: "user_upload",
          });
        }
      }

      // ── Step 7: Connections update ─────────────────────────────────────────
      // Career stats only. For trainer + jockey.
      for (const [name, role] of [
        [horseData.trainer, "trainer"],
        [horseData.jockey, "jockey"],
      ] as [string | null, string][]) {
        if (!name) continue;

        const { data: existingConn } = await admin
          .from("connections")
          .select("id, source")
          .eq("name", name)
          .eq("role", role)
          .maybeSingle();

        if (existingConn) {
          // Merge: update updated_at. Career stats only updated if incoming is higher trust.
          await admin.from("connections").update({ updated_at: new Date().toISOString() }).eq("id", existingConn.id);
        } else {
          await admin.from("connections").insert({
            name,
            role,
            source: "user_upload",
          });
        }
      }

      results.push({ horse_name: horseData.name, horse_id: horseId, status: "written" });
    }

    // ── Recompute field_size from distinct horse_ids in performance ────────────
    if (raceId) {
      try {
        const { data: perfRows } = await admin
          .from("performance")
          .select("horse_id")
          .eq("race_id", raceId);
        const distinctCount = new Set(perfRows?.map((r) => r.horse_id) ?? []).size;
        await admin.from("races").update({ field_size: distinctCount }).eq("id", raceId);
      } catch (fieldSizeErr) {
        console.warn("[ingest/extract] field_size recompute failed:", fieldSizeErr);
      }
    }

    // ── Step 9: Ingestion log write ───────────────────────────────────────────
    const finalStatus = flags.length > 0 ? "partial" : "success";
    const flagSummary = flags.length > 0 ? JSON.stringify(flags) : null;

    const { data: logEntry } = await admin
      .from("ingestion_log")
      .insert({
        user_id: user.id,
        source: "upload",
        source_ref: pendingDoc.pdf_hash,
        pdf_hash: pendingDoc.pdf_hash,
        horse_id: primaryHorseId,
        race_id: raceId,
        status: finalStatus,
        notes: flagSummary,
      })
      .select("id")
      .single();

    // ── Step 8: Job status update ─────────────────────────────────────────────
    await admin
      .from("ingestion_jobs")
      .update({
        status: finalStatus,
        ingestion_log_id: logEntry?.id ?? null,
      })
      .eq("pdf_hash", pendingDoc.pdf_hash)
      .eq("race_index", race_index)
      .eq("user_id", user.id);

    // Update pending_documents: move race_index from pending to extracted
    const newExtracted = [...(pendingDoc.races_extracted as number[]), race_index];
    const newPending = (pendingDoc.races_pending as number[]).filter((r) => r !== race_index);

    await admin
      .from("pending_documents")
      .update({
        races_extracted: newExtracted,
        races_pending: newPending,
      })
      .eq("id", pending_document_id);

    console.log(
      `[ingest/extract] race ${race_index}/${pendingDoc.total_races} — status: ${finalStatus} | horses: ${results.length} | flags: ${flags.length}`,
    );

    // ── Step 10: User feedback ────────────────────────────────────────────────
    const trackLabel = raceData.track_name ?? "unknown track";
    const dateLabel = raceData.race_date ?? "";
    const horseLabel = extraction.horses[0]?.name ?? "Horse";

    let message: string;
    if (finalStatus === "success") {
      message = `Brain updated. ${horseLabel} — Race ${race_index} at ${trackLabel}${dateLabel ? ` (${dateLabel})` : ""} added.`;
    } else {
      message = `Brain updated with flags. Some fields could not be confirmed — check for extraction flags.`;
    }

    return json({
      status: finalStatus,
      message,
      horse_id: primaryHorseId,
      race_id: raceId,
      races_extracted: newExtracted,
      races_pending: newPending,
      extraction_flags: flags,
    });
  } catch (err) {
    console.error("[ingest/extract] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return json({ error: message }, 500);
  }
}
