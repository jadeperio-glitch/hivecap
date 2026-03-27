import * as pdfParseModule from "pdf-parse";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pdfParse: (buf: Buffer) => Promise<{ text: string }> =
  (pdfParseModule as any).default ?? pdfParseModule;
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export async function POST(request: Request) {
  // ── Auth ────────────────────────────────────────────────────────────────────
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Parse form data ──────────────────────────────────────────────────────────
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "Invalid form data" }, { status: 400 });
  }

  const fileEntry = formData.get("file");
  if (!fileEntry || typeof fileEntry === "string") {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }

  const file = fileEntry as File;

  // ── Validate ─────────────────────────────────────────────────────────────────
  if (file.type !== "application/pdf") {
    return Response.json({ error: "PDF files only" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return Response.json({ error: "File exceeds 10 MB limit" }, { status: 400 });
  }

  // ── Extract text ─────────────────────────────────────────────────────────────
  let extractedText: string;
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const parsed = await pdfParse(buffer);
    extractedText = parsed.text.trim();
  } catch {
    return Response.json(
      { error: "Could not extract text from PDF" },
      { status: 422 },
    );
  }

  if (!extractedText) {
    return Response.json(
      { error: "PDF appears to contain no extractable text (scanned image?)" },
      { status: 422 },
    );
  }

  // ── Store ────────────────────────────────────────────────────────────────────
  const { error: dbError } = await supabase.from("user_documents").insert({
    user_id: user.id,
    filename: file.name,
    extracted_text: extractedText,
  });

  if (dbError) {
    console.error("[upload] DB insert error:", dbError.message);
    return Response.json({ error: "Failed to save document" }, { status: 500 });
  }

  return Response.json({ success: true, filename: file.name });
}
