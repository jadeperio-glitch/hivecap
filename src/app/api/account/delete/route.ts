import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function json(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function DELETE() {
  try {
    // ── Verify service role key is configured ───────────────────────────────
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY === "your_service_role_key_here") {
      console.error("[account/delete] SUPABASE_SERVICE_ROLE_KEY is not set. Get it from: Supabase Dashboard → Settings → API → service_role (secret) key. Add it to .env.local and Vercel environment variables.");
      return json({ error: "Server misconfiguration: service role key not set" }, 500);
    }

    // ── Auth ────────────────────────────────────────────────────────────────
    const supabase = createClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();

    if (authErr) {
      console.error("[account/delete] auth.getUser error:", authErr.message, authErr);
      return json({ error: "Unauthorized" }, 401);
    }
    if (!user) {
      console.error("[account/delete] no user in session");
      return json({ error: "Unauthorized" }, 401);
    }

    console.log("[account/delete] starting deletion for user:", user.id);

    // Use admin client (service role) for all deletes — bypasses RLS
    const admin = createAdminClient();

    // ── 1. Messages (child of conversations) ────────────────────────────────
    const { error: msgsErr } = await admin
      .from("messages")
      .delete()
      .eq("user_id", user.id);
    if (msgsErr) {
      console.error("[account/delete] messages delete error:", msgsErr.message, msgsErr);
      return json({ error: "Failed to delete messages" }, 500);
    }
    console.log("[account/delete] messages deleted");

    // ── 2. Conversations ────────────────────────────────────────────────────
    const { error: convsErr } = await admin
      .from("conversations")
      .delete()
      .eq("user_id", user.id);
    if (convsErr) {
      console.error("[account/delete] conversations delete error:", convsErr.message, convsErr);
      return json({ error: "Failed to delete conversations" }, 500);
    }
    console.log("[account/delete] conversations deleted");

    // ── 3. Posts ────────────────────────────────────────────────────────────
    const { error: postsErr } = await admin
      .from("posts")
      .delete()
      .eq("user_id", user.id);
    if (postsErr) {
      console.error("[account/delete] posts delete error:", postsErr.message, postsErr);
      return json({ error: "Failed to delete posts" }, 500);
    }
    console.log("[account/delete] posts deleted");

    // ── 4. User documents ───────────────────────────────────────────────────
    const { error: docsErr } = await admin
      .from("user_documents")
      .delete()
      .eq("user_id", user.id);
    if (docsErr) {
      console.error("[account/delete] user_documents delete error:", docsErr.message, docsErr);
      return json({ error: "Failed to delete documents" }, 500);
    }
    console.log("[account/delete] user_documents deleted");

    // ── 5. Profile ──────────────────────────────────────────────────────────
    const { error: profileErr } = await admin
      .from("profiles")
      .delete()
      .eq("id", user.id);
    if (profileErr) {
      console.error("[account/delete] profile delete error:", profileErr.message, profileErr);
      return json({ error: "Failed to delete profile" }, 500);
    }
    console.log("[account/delete] profile deleted");

    // ── 6. Auth user ────────────────────────────────────────────────────────
    const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);
    if (deleteErr) {
      console.error("[account/delete] auth.admin.deleteUser error:", deleteErr.message, deleteErr);
      return json({ error: "Failed to delete auth user: " + deleteErr.message }, 500);
    }
    console.log("[account/delete] auth user deleted — account fully removed:", user.id);

    return json({ success: true });
  } catch (err) {
    console.error("[account/delete] unhandled error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: "Internal server error: " + message }, 500);
  }
}
