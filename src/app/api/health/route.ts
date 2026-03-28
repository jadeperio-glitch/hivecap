import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  const report: Record<string, unknown> = {};

  // ── Env vars (presence only — never expose values) ──────────────────────────
  report.env = {
    ANTHROPIC_API_KEY:           !!process.env.ANTHROPIC_API_KEY,
    NEXT_PUBLIC_SUPABASE_URL:    !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY:   !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    RACING_API_BASE_URL:         !!process.env.RACING_API_BASE_URL,
    RACING_API_USERNAME:         !!process.env.RACING_API_USERNAME,
    RACING_API_PASSWORD:         !!process.env.RACING_API_PASSWORD,
  };

  // ── Supabase admin client — test query ──────────────────────────────────────
  try {
    const admin = createAdminClient();
    // Lightweight query: count rows in posts (any number is fine, just tests connectivity)
    const { count, error } = await admin
      .from("posts")
      .select("*", { count: "exact", head: true });

    if (error) {
      report.supabase = { ok: false, error: error.message, code: error.code };
    } else {
      report.supabase = { ok: true, posts_count: count };
    }
  } catch (err) {
    const e = err as Error;
    report.supabase = { ok: false, error: e.message, stack: e.stack };
  }

  // ── Supabase anon client — test auth.getUser (no session = expected null) ───
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const supabase = createClient();
    const { error } = await supabase.auth.getUser();
    // No session in a health check is normal — a missing-key error is not
    if (error && error.message !== "Auth session missing!") {
      report.supabase_anon = { ok: false, error: error.message };
    } else {
      report.supabase_anon = { ok: true };
    }
  } catch (err) {
    const e = err as Error;
    report.supabase_anon = { ok: false, error: e.message, stack: e.stack };
  }

  // ── Overall status ───────────────────────────────────────────────────────────
  const env = report.env as Record<string, boolean>;
  const allEnvSet = Object.values(env).every(Boolean);
  const supabaseOk = (report.supabase as { ok: boolean }).ok;
  const healthy = allEnvSet && supabaseOk;

  return json({ healthy, ...report }, healthy ? 200 : 500);
}
