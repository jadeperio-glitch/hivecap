import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Anthropic from "@anthropic-ai/sdk";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const SCAN_TEXT_LIMIT = 4000; // chars fed to lightweight scan call

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight scan prompt — returns document_type, total_races, race_date,
// track_name, track_abbreviation, race_numbers. One call, cheap, fast.
// ─────────────────────────────────────────────────────────────────────────────
const SCAN_SYSTEM = `You are scanning a horse racing document for the HiveCap Brain ingestion system.

Return ONLY a valid JSON object with exactly these fields:
{
  "document_type": "past_performance" | "result_chart" | "race_card" | "clocker_report" | "workout_tab" | "unrecognized",
  "total_races": <integer or null>,
  "race_numbers": [<integer>, ...] or null,
  "race_date": "<YYYY-MM-DD> or null",
  "track_name": "<string> or null",
  "track_abbreviation": "<2-3 letter abbreviation> or null",
  "notes": "<any relevant context>"
}

Rules:
- If the document is unrecognized, set total_races and race_numbers to null.
- total_races = number of DISTINCT race programs (race cards) in the document — i.e., distinct combinations of race date + race number + track.
  - A past performance sheet for one horse still counts as 1 race card, even if it shows many prior starts in the PP history section.
  - A multi-race past performance packet (e.g., full field PP for a single race) counts as 1.
  - A result chart PDF covering multiple race numbers on the same card counts each race number as a separate race (e.g., Race 1, Race 2 … Race 9 = 9).
  - Do NOT count individual horse past performance lines as races.
- race_numbers is an ordered array of the ACTUAL race numbers from the document (e.g., [7] for a single Race 7 PP sheet, [1,2,3,4,5,6,7,8,9] for a 9-race result chart). Length must equal total_races. If the race number cannot be determined, use sequential integers starting at 1.
- race_date is the date of the MOST RECENT race card in the document (or the scheduled race date for race cards).
- Return only the JSON. No preamble, no explanation, no markdown fences.`;

export async function POST(request: Request) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    const supabase = createClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ── Parse form data ────────────────────────────────────────────────────────
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return json({ error: "Invalid form data" }, 400);
    }

    const fileEntry = formData.get("file");
    const clientHash = formData.get("hash");

    if (!fileEntry || typeof fileEntry === "string") {
      return json({ error: "No file provided" }, 400);
    }
    if (!clientHash || typeof clientHash !== "string") {
      return json({ error: "No file hash provided" }, 400);
    }

    const file = fileEntry as File;

    if (file.type !== "application/pdf") {
      return json({ error: "PDF files only" }, 400);
    }
    if (file.size > MAX_BYTES) {
      return json({ error: "File exceeds 10 MB limit" }, 400);
    }

    const admin = createAdminClient();

    // ── Step 2a: Hash dedup check — three-branch ownership logic ─────────────
    // No FK joins. Two explicit sequential queries: ingestion_log → horses.
    //
    // Branch A: horse uploaded_by = current_user → block (user already owns this data)
    // Branch B: horse brain_layer = 'shared'     → block (accessible via shared Brain)
    // Branch C: all horses are other users' personal data → allow (user needs their own copy)
    console.log("[ingest] checking dedup for hash:", clientHash, "| user:", user.id);

    // Pre-check: same user already has this in their pending pipeline (scan in progress,
    // no ingestion_log entry yet)
    const { data: existingPending } = await admin
      .from("pending_documents")
      .select("id")
      .eq("pdf_hash", clientHash)
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (existingPending) {
      console.log("[ingest] duplicate — pending_documents for this user:", clientHash);
      return json({ duplicate: true, message: "Brain already has this document." });
    }

    // Step 1: All ingestion_log rows for this hash (successful/partial extractions only)
    const { data: logRows } = await admin
      .from("ingestion_log")
      .select("user_id, horse_id")
      .eq("pdf_hash", clientHash)
      .in("status", ["success", "partial"])
      .limit(20);

    if (logRows && logRows.length > 0) {
      // Step 2: Collect distinct horse_ids from those rows
      const horseIds = [
        ...new Set(logRows.map((r) => r.horse_id).filter((id): id is string => !!id)),
      ];

      // Step 3: Query horses directly for uploaded_by + brain_layer (no FK join)
      let horsesData: Array<{ id: string; uploaded_by: string | null; brain_layer: string | null }> = [];
      if (horseIds.length > 0) {
        const { data: result } = await admin
          .from("horses")
          .select("id, uploaded_by, brain_layer")
          .in("id", horseIds);
        horsesData = result ?? [];
      }

      console.log("[ingest] dedup horses found:", horsesData.length, "for hash:", clientHash);

      // Branch A: any horse owned by this user → block
      if (horsesData.some((h) => h.uploaded_by === user.id)) {
        console.log("[ingest] Branch A — user already owns this document:", clientHash);
        return json({ duplicate: true, message: "Brain already has this document." });
      }

      // Branch B: any horse in the shared Brain → block (accessible to all users)
      if (horsesData.some((h) => h.brain_layer === "shared")) {
        console.log("[ingest] Branch B — data is in the shared Brain:", clientHash);
        return json({ duplicate: true, message: "Brain already has this document — it's available to you in the shared Brain." });
      }

      // Branch C: all horses are other users' personal data → allow
      console.log("[ingest] Branch C — all matches are other users' personal data, allowing upload:", clientHash);
    }

    // ── Extract text from PDF ─────────────────────────────────────────────────
    let extractedText: string;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse/lib/pdf-parse.js");
      const parsed = await pdfParse(buffer);
      extractedText = (parsed.text as string).trim();
    } catch (parseErr) {
      console.error("[ingest] pdf-parse error:", parseErr);
      return json({ error: "Could not extract text from PDF" }, 422);
    }

    if (!extractedText) {
      return json(
        { error: "PDF appears to contain no extractable text (scanned image?)" },
        422,
      );
    }

    // ── Step 2 + 2b: Lightweight Claude scan ─────────────────────────────────
    // Single call: detect document type, count races, get race date + track.
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let scan: {
      document_type: string;
      total_races: number | null;
      race_numbers: number[] | null;
      race_date: string | null;
      track_name: string | null;
      track_abbreviation: string | null;
      notes: string;
    };

    try {
      const scanResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 256,
        system: SCAN_SYSTEM,
        messages: [
          {
            role: "user",
            content: `Document content (first ${SCAN_TEXT_LIMIT} chars):\n\n${extractedText.slice(0, SCAN_TEXT_LIMIT)}`,
          },
        ],
      });

      const raw = scanResponse.content[0].type === "text"
        ? scanResponse.content[0].text.trim()
        : "";

      // Strip markdown fences if Claude wraps anyway
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      scan = JSON.parse(cleaned);
    } catch (scanErr) {
      console.error("[ingest] scan call error:", scanErr);
      return json({ error: "Could not scan document. Try again." }, 500);
    }

    if (scan.document_type === "unrecognized") {
      console.log("[ingest] unrecognized document:", scan.notes);
      return json({
        error: `Unrecognized document type. ${scan.notes || "Please upload a past performance sheet, result chart, race card, clocker report, or workout tab."}`,
      }, 422);
    }

    const totalRaces = scan.total_races ?? 1;

    // ── Upload extracted text to Supabase Storage ─────────────────────────────
    // We store extracted text (not the raw PDF). storage_ref is the path.
    // The bucket is created by the migration. If it doesn't exist yet,
    // createBucket is idempotent.
    await admin.storage.createBucket("brain-ingestion", { public: false }).catch(() => {
      // Bucket already exists — ignore.
    });

    const storageRef = `${user.id}/${clientHash}.txt`;
    const textBuffer = Buffer.from(extractedText, "utf-8");

    const { error: storageErr } = await admin.storage
      .from("brain-ingestion")
      .upload(storageRef, textBuffer, {
        contentType: "text/plain",
        upsert: true,
      });

    if (storageErr) {
      console.error("[ingest] storage upload error:", storageErr);
      return json({ error: "Failed to store document for extraction" }, 500);
    }

    // ── Compute expires_at = MAX(race_date, now()) + 24 hours ─────────────────
    const now = Date.now();
    const raceDateMs = scan.race_date ? new Date(scan.race_date).getTime() : now;
    const expiresAt = new Date(Math.max(raceDateMs, now) + 24 * 60 * 60 * 1000).toISOString();

    // ── Insert pending_documents ───────────────────────────────────────────────
    const racesArr = Array.from({ length: totalRaces }, (_, i) => i + 1);

    const { data: pendingDoc, error: pendingErr } = await admin
      .from("pending_documents")
      .insert({
        user_id: user.id,
        pdf_hash: clientHash,
        document_type: scan.document_type,
        total_races: totalRaces,
        race_date: scan.race_date ?? null,
        races_extracted: [],
        races_pending: racesArr,
        storage_ref: storageRef,
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (pendingErr || !pendingDoc) {
      console.error("[ingest] pending_documents insert error:", pendingErr);
      return json({ error: "Failed to create ingestion record" }, 500);
    }

    // ── Insert ingestion_jobs (one per race, all queued) ───────────────────────
    const jobs = racesArr.map((raceIndex) => ({
      user_id: user.id,
      pdf_hash: clientHash,
      race_index: raceIndex,
      total_races: totalRaces,
      status: "queued",
    }));

    const { error: jobsErr } = await admin.from("ingestion_jobs").insert(jobs);

    if (jobsErr) {
      console.error("[ingest] ingestion_jobs insert error:", jobsErr);
      // Non-fatal — jobs can be recreated. Log and continue.
    }

    console.log(
      `[ingest] scan complete — type: ${scan.document_type} | races: ${totalRaces} | date: ${scan.race_date} | track: ${scan.track_name} | pending_doc: ${pendingDoc.id}`,
    );

    return json({
      pending_document_id: pendingDoc.id,
      document_type: scan.document_type,
      total_races: totalRaces,
      race_numbers: scan.race_numbers ?? racesArr,
      race_date: scan.race_date,
      track_name: scan.track_name,
      track_abbreviation: scan.track_abbreviation,
      races_pending: racesArr,
      filename: file.name,
    });
  } catch (err) {
    console.error("[ingest] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return json({ error: message }, 500);
  }
}
