import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── GET — all posts, reverse chronological ─────────────────────────────────
export async function GET() {
  try {
    const supabase = createClient();
    const { data: posts, error } = await supabase
      .from("posts")
      .select("id, user_email, username, project_id, conversation_id, content, brain_verified, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[posts] GET error:", error.message);
      return json({ error: "Failed to fetch posts" }, 502);
    }

    return json({ posts: posts ?? [] });
  } catch (err) {
    console.error("[posts] GET threw:", err);
    return json({ error: "Internal server error" }, 500);
  }
}

// ── POST — create a post for the authenticated user ────────────────────────
export async function POST(request: Request) {
  try {
    // Auth
    let user: { id: string; email?: string } | null = null;
    try {
      const supabase = createClient();
      const { data, error: authErr } = await supabase.auth.getUser();
      if (authErr) console.error("[posts] auth error:", authErr.message);
      else user = data.user;
    } catch (authErr) {
      console.error("[posts] auth threw:", authErr);
    }

    if (!user) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Parse body
    let body: {
      content?: string;
      brain_verified?: boolean;
      project_id?: string | null;
      conversation_id?: string | null;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const { content, brain_verified = false, project_id = null, conversation_id = null } = body;

    if (!content || typeof content !== "string" || !content.trim()) {
      return json({ error: "content is required" }, 400);
    }
    const adminIds = (process.env.HIVECAP_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const isAdmin = adminIds.includes(user.id);
    if (!isAdmin && content.length > 2000) {
      return json({ error: "content exceeds 2000 character limit" }, 400);
    }

    // Look up username from profiles
    const supabase = createClient();
    const { data: profile } = await supabase
      .from("profiles")
      .select("username")
      .eq("id", user.id)
      .maybeSingle();

    const username = profile?.username ?? null;

    // Insert
    const { data: post, error: insertErr } = await supabase
      .from("posts")
      .insert({
        user_id: user.id,
        user_email: user.email ?? "unknown",
        username,
        content: content.trim(),
        brain_verified: Boolean(brain_verified),
        project_id: project_id || null,
        conversation_id: conversation_id || null,
      })
      .select("id, user_email, username, project_id, conversation_id, content, brain_verified, created_at")
      .single();

    if (insertErr) {
      console.error("[posts] insert error:", insertErr.message, insertErr);
      return json({ error: "Failed to create post" }, 500);
    }

    return json({ success: true, post });
  } catch (err) {
    console.error("[posts] POST threw:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
