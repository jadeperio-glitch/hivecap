import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
      .select("id, user_id, user_email, project_id, conversation_id, content, brain_verified, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[posts] GET error:", error.message);
      return json({ error: "Failed to fetch posts" }, 502);
    }

    if (!posts || posts.length === 0) return json({ posts: [] });

    // Resolve current usernames from profiles (live lookup — not the post-time snapshot).
    // Admin client used because GET is unauthenticated and profiles RLS requires a session.
    const admin = createAdminClient();
    const userIds = Array.from(new Set(posts.map((p) => p.user_id)));
    const { data: profiles } = await admin
      .from("profiles")
      .select("id, username")
      .in("id", userIds);

    const usernameByUserId = new Map(
      (profiles ?? []).map((p) => [p.id, p.username as string | null]),
    );

    // Replace stored username snapshot with live value; keep user_id for ownership checks (delete button).
    // Falls back to null — feed page renders username ?? user_email.
    const enriched = posts.map((p) => ({
      ...p,
      username: usernameByUserId.get(p.user_id) ?? null,
    }));

    return json({ posts: enriched });
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
      project_id?: string | null;
      conversation_id?: string | null;
    };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const { content, project_id = null, conversation_id = null } = body;

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
        brain_verified: isAdmin || Boolean(conversation_id), // admin posts always verified; non-admin requires conversation_id
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

// ── DELETE — delete a post owned by the authenticated user ─────────────────
export async function DELETE(request: Request) {
  try {
    const supabase = createClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    let body: { id?: string };
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    if (!body.id) return json({ error: "id is required" }, 400);

    const adminIds = (process.env.HIVECAP_ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const isAdmin = adminIds.includes(user.id);

    // Build delete query — admins can delete any post; others only their own
    const base = supabase.from("posts").delete().eq("id", body.id);
    const query = isAdmin ? base : base.eq("user_id", user.id);

    const { error: deleteErr } = await query;
    if (deleteErr) {
      console.error("[posts] DELETE error:", deleteErr.message);
      return json({ error: "Failed to delete post" }, 500);
    }

    return json({ success: true });
  } catch (err) {
    console.error("[posts] DELETE threw:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
