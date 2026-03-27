import * as pdfParseModule from "pdf-parse";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse: (buf: Buffer) => Promise<{ text: string }> =
  (pdfParseModule as any).default ?? pdfParseModule;
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(request: Request) {
  try {
    // ── Auth ──────────────────────────────────────────────────────────────────
    let user: { id: string } | null = null;
    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.getUser();
      if (error) {
        console.error("[upload] auth.getUser error:", error.message);
      } else {
        user = data.user;
      }
    } catch (authErr) {
      console.error("[upload] auth setup threw:", authErr);
    }

    if (!user) {
      return json({ error: "Unauthorized" }, 401);
    }

    // ── Parse form data ────────────────────────────────────────────────────────
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (fdErr) {
      console.error("[upload] formData parse error:", fdErr);
      return json({ error: "Invalid form data" }, 400);
    }

    const fileEntry = formData.get("file");
    if (!fileEntry || typeof fileEntry === "string") {
      return json({ error: "No file provided" }, 400);
    }

    const file = fileEntry as File;

    // ── Validate ───────────────────────────────────────────────────────────────
    if (file.type !== "application/pdf") {
      return json({ error: "PDF files only" }, 400);
    }
    if (file.size > MAX_BYTES) {
      return json({ error: "File exceeds 10 MB limit" }, 400);
    }

    // ── Extract text ───────────────────────────────────────────────────────────
    let extractedText: string;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsed = await pdfParse(buffer);
      extractedText = parsed.text.trim();
    } catch (parseErr) {
      console.error("[upload] pdf-parse error:", parseErr);
      return json({ error: "Could not extract text from PDF" }, 422);
    }

    if (!extractedText) {
      return json(
        { error: "PDF appears to contain no extractable text (scanned image?)" },
        422,
      );
    }

    // ── Store ──────────────────────────────────────────────────────────────────
    const supabase = createClient();
    const { error: dbError } = await supabase.from("user_documents").insert({
      user_id: user.id,
      filename: file.name,
      extracted_text: extractedText,
    });

    if (dbError) {
      console.error("[upload] DB insert error:", dbError.message, dbError);
      return json({ error: "Failed to save document" }, 500);
    }

    return json({ success: true, filename: file.name });
  } catch (err) {
    // Catch-all: ensure we never return an HTML error page
    console.error("[upload] Unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
