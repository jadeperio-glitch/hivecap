import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import Anthropic from "@anthropic-ai/sdk";
import { checkRaceCoverage, RaceCoverageResult } from "@/lib/brain-coverage";

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

// ─────────────────────────────────────────────────────────────────────────────
// Coverage check helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatRaceLabel(track: string, date: string, raceNumber: number): string {
  const d = new Date(date + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  });
  return `Race ${raceNumber} at ${track} on ${d}`;
}

function buildCoverageMessage(track: string, date: string, covered: RaceCoverageResult[]): string {
  if (covered.length === 1) {
    return `${formatRaceLabel(track, date, covered[0].race_number)} is already in shared Brain — full field. Ask the Brain anything about it.`;
  }
  return `${covered.length} races at ${track} on ${new Date(date + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} are already in shared Brain. Ask the Brain anything about them.`;
}

function buildSuggestedPrompts(track: string, date: string, covered: RaceCoverageResult[]): string[] {
  const raceLabel = formatRaceLabel(track, date, covered[0].race_number);
  const isDerby = /derby|churchill/i.test(track);

  if (isDerby) {
    return [
      "Who are the pace horses in this race and how does the pace scenario set up?",
      "Which horse has the best Beyer speed figure heading into this race?",
      "Analyze the post draw — which posts are advantaged at this distance?",
    ];
  }

  return [
    `What's the pace scenario for ${raceLabel}?`,
    "Which horse has the best recent Beyer figure in the field?",
    "Post draw analysis for this race",
  ];
}

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

    // Pre-check: same user already has this in their pending pipeline.
    // Three outcomes:
    //   expired → delete stale record, proceed fresh
    //   stuck (0 races extracted, created > 1 hour ago) → delete, proceed fresh
    //   active (races in progress) → block, return ready
    const { data: existingPending } = await admin
      .from("pending_documents")
      .select("id, expires_at, races_extracted, created_at")
      .eq("pdf_hash", clientHash)
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    if (existingPending) {
      const now = new Date();
      const isExpired = new Date(existingPending.expires_at) < now;
      const racesExtracted = (existingPending.races_extracted as number[]) ?? [];
      const createdAt = new Date(existingPending.created_at);
      const ageMs = now.getTime() - createdAt.getTime();
      const isStuck = racesExtracted.length === 0 && ageMs > 2 * 60 * 60 * 1000; // 0 extracted, >2h old

      if (isExpired || isStuck) {
        console.log("[ingest] stale pending record — deleting and allowing fresh upload | expired:", isExpired, "| stuck:", isStuck, "| hash:", clientHash);
        await admin.from("pending_documents").delete().eq("id", existingPending.id);
        // Also clean up any orphaned ingestion_jobs for this hash/user
        await admin.from("ingestion_jobs").delete().eq("pdf_hash", clientHash).eq("user_id", user.id);
      } else {
        console.log("[ingest] active pending record — user is mid-pipeline:", clientHash, "| races_extracted:", racesExtracted.length);
        return json({ status: "ready", message: "Got it — ready to analyze." });
      }
    }

    // Cross-user hash short-circuit: if this pdf_hash was already successfully ingested
    // by anyone AND the resulting horses landed in shared/gated layer, skip extraction entirely.
    {
      const { data: priorIngestions } = await admin
        .from("ingestion_log")
        .select("pdf_hash, horse_id, status")
        .eq("pdf_hash", clientHash)
        .eq("status", "success")
        .not("horse_id", "is", null);

      if (priorIngestions && priorIngestions.length > 0) {
        const priorHorseIds = priorIngestions.map((r) => r.horse_id as string);
        const { data: sharedHorses } = await admin
          .from("horses")
          .select("id")
          .in("id", priorHorseIds)
          .in("brain_layer", ["shared", "gated"]);

        if (sharedHorses && sharedHorses.length > 0) {
          console.log("[ingest] hash short-circuit — pdf already in shared Brain:", clientHash, "| matched horses:", sharedHorses.length);

          const { error: logErr } = await admin.from("ingestion_log").insert({
            user_id: user.id,
            source: "upload",
            source_ref: clientHash,
            pdf_hash: clientHash,
            horse_id: null,
            status: "reused_from_shared",
            notes: JSON.stringify([{
              field: "hash_short_circuit",
              note: `pdf_hash already ingested with shared horses; granted access without re-extraction. Matched ${sharedHorses.length} shared horses.`,
            }]),
          });
          if (logErr) console.error("[ingest] hash short-circuit log insert failed:", logErr.message, logErr.code, logErr.details);

          return json({
            status: "reused_from_shared",
            message: "This document is already in the shared Brain. You can ask questions about it now.",
            races_pending: 0,
            races_extracted: 0,
            total_races: 0,
          });
        }
      }
    }

    // Step 1: All ingestion_log rows for this hash (successful/partial extractions only)
    const { data: logRows } = await admin
      .from("ingestion_log")
      .select("user_id, horse_id, race_id")
      .eq("pdf_hash", clientHash)
      .in("status", ["success", "partial"])
      .limit(20);

    if (logRows && logRows.length > 0) {
      // Step 2: Collect distinct horse_ids from those rows
      const horseIds = Array.from(new Set(logRows.map((r) => r.horse_id).filter((id): id is string => !!id)));

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

      // Branch A: any horse owned by this user — data already exists, confirm silently
      if (horsesData.some((h) => h.uploaded_by === user.id)) {
        console.log("[ingest] Branch A — user already owns this document:", clientHash);
        return json({ status: "ready", message: "Got it — ready to analyze." });
      }

      // Branch B: any horse in the shared Brain — accessible to this user, confirm silently.
      // Upgrade to already_covered response shape when we can resolve race info from the log.
      if (horsesData.some((h) => h.brain_layer === "shared")) {
        console.log("[ingest] Branch B — data is in the shared Brain:", clientHash);

        const raceIds = Array.from(
          new Set(logRows.map((r) => r.race_id).filter((id): id is string => !!id))
        );

        if (raceIds.length > 0) {
          const { data: raceRows } = await admin
            .from("races")
            .select("id, race_number, race_date, tracks(name)")
            .in("id", raceIds);

          if (raceRows && raceRows.length > 0) {
            const firstRace = raceRows[0];
            const trackName =
              (Array.isArray(firstRace.tracks)
                ? firstRace.tracks[0]?.name
                : (firstRace.tracks as { name: string } | null)?.name) ?? null;
            const raceDate: string | null = firstRace.race_date;

            if (trackName && raceDate) {
              const coveredRaces: RaceCoverageResult[] = raceRows.map((r) => ({
                race_number: r.race_number,
                race_id: r.id,
                covered: true,
                reason: "fully_covered",
              }));

              return json({
                status: "already_covered",
                message: buildCoverageMessage(trackName, raceDate, coveredRaces),
                track_name: trackName,
                race_date: raceDate,
                races_covered: coveredRaces.map((r) => ({
                  race_number: r.race_number,
                  race_id: r.race_id,
                })),
                suggested_prompts: buildSuggestedPrompts(trackName, raceDate, coveredRaces),
              });
            }
          }
        }

        // Fallback when race info is unavailable (old log rows without race_id)
        return json({ status: "ready", message: "Got it — ready to analyze." });
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
        model: "claude-sonnet-4-6",
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
    const racesArr = Array.from({ length: totalRaces }, (_, i) => i + 1);
    const actualRaceNumbers: number[] = scan.race_numbers ?? racesArr;

    // ── Coverage check — runs BEFORE storage upload ────────────────────────────
    // Resolve the track by name (case-insensitive). If found, check whether all
    // or some of the scanned races are already fully seeded in shared Brain.
    // This prevents users from triggering expensive Claude extraction calls for
    // races the admin has already seeded.
    //
    // TODO (Phase 4): add a "force upload" escape hatch for users who want a
    // personal copy even when shared coverage exists.
    let racesToQueue: number[] = racesArr; // default: queue all (1..N indices)
    let coveragePartial: { covered: RaceCoverageResult[]; queued: RaceCoverageResult[] } | null = null;

    if (scan.track_name && scan.race_date && actualRaceNumbers.length > 0) {
      const { data: trackRow } = await admin
        .from("tracks")
        .select("id")
        .ilike("name", scan.track_name)
        .maybeSingle();

      if (trackRow) {
        console.log("[ingest] coverage check — track found:", trackRow.id, "| races:", actualRaceNumbers);

        const coverage = await checkRaceCoverage({
          track_id: trackRow.id,
          race_date: scan.race_date,
          race_numbers: actualRaceNumbers,
        });

        const coveredRaces = coverage.filter((r) => r.covered);
        const uncoveredRaces = coverage.filter((r) => !r.covered);

        console.log("[ingest] coverage result — covered:", coveredRaces.length, "| uncovered:", uncoveredRaces.length);

        // Case A: ALL races covered → short-circuit entirely. No storage, no pending_doc, no jobs.
        if (uncoveredRaces.length === 0 && coveredRaces.length > 0) {
          return json({
            status: "already_covered",
            message: buildCoverageMessage(scan.track_name, scan.race_date, coveredRaces),
            track_name: scan.track_name,
            race_date: scan.race_date,
            races_covered: coveredRaces.map((r) => ({
              race_number: r.race_number,
              race_id: r.race_id,
            })),
            suggested_prompts: buildSuggestedPrompts(scan.track_name, scan.race_date, coveredRaces),
          });
        }

        // Case B: PARTIAL coverage → only queue uncovered race indices.
        if (coveredRaces.length > 0 && uncoveredRaces.length > 0) {
          const uncoveredActualNums = new Set(uncoveredRaces.map((r) => r.race_number));
          racesToQueue = actualRaceNumbers
            .map((raceNum, idx) => (uncoveredActualNums.has(raceNum) ? idx + 1 : null))
            .filter((i): i is number => i !== null);
          coveragePartial = { covered: coveredRaces, queued: uncoveredRaces };
          console.log("[ingest] partial coverage — queuing indices:", racesToQueue);
        }

        // Case C: no coverage → racesToQueue unchanged (all indices)
      }
    }

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

    // ── Compute expires_at = MAX(race_date end-of-day, now()) + 24 hours ───────
    // Parsing "YYYY-MM-DD" as UTC midnight under-counts by ~24h for users in
    // any timezone. Use end-of-day (23:59:59 UTC) as the race_date anchor so a
    // same-day or next-day upload always gets the full 24h window after the race.
    const now = Date.now();
    const raceDateMs = scan.race_date
      ? new Date(`${scan.race_date}T23:59:59Z`).getTime()
      : now;
    const expiresAt = new Date(Math.max(raceDateMs, now) + 24 * 60 * 60 * 1000).toISOString();

    // ── Insert pending_documents ───────────────────────────────────────────────
    // racesToQueue may be a subset of racesArr when partial coverage applies.

    const { data: pendingDoc, error: pendingErr } = await admin
      .from("pending_documents")
      .insert({
        user_id: user.id,
        pdf_hash: clientHash,
        document_type: scan.document_type,
        total_races: totalRaces,
        race_date: scan.race_date ?? null,
        races_extracted: [],
        races_pending: racesToQueue,
        storage_ref: storageRef,
        expires_at: expiresAt,
      })
      .select("id")
      .single();

    if (pendingErr || !pendingDoc) {
      console.error("[ingest] pending_documents insert error:", pendingErr);
      return json({ error: "Failed to create ingestion record" }, 500);
    }

    // ── Insert ingestion_jobs (one per queued race) ────────────────────────────
    const jobs = racesToQueue.map((raceIndex) => ({
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
      `[ingest] scan complete — type: ${scan.document_type} | races: ${totalRaces} | queued: ${racesToQueue.length} | date: ${scan.race_date} | track: ${scan.track_name} | pending_doc: ${pendingDoc.id}`,
    );

    return json({
      pending_document_id: pendingDoc.id,
      document_type: scan.document_type,
      total_races: totalRaces,
      race_numbers: actualRaceNumbers,
      race_date: scan.race_date,
      track_name: scan.track_name,
      track_abbreviation: scan.track_abbreviation,
      races_pending: racesToQueue,
      filename: file.name,
      // Present when some races were already covered — UI shows a combined message.
      coverage_partial: coveragePartial
        ? {
            covered: coveragePartial.covered.map((r) => ({
              race_number: r.race_number,
              race_id: r.race_id,
            })),
            queued: coveragePartial.queued.map((r) => ({ race_number: r.race_number })),
          }
        : null,
    });
  } catch (err) {
    console.error("[ingest] unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return json({ error: message }, 500);
  }
}
