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
    const supabase = createClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();

    if (authErr || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    // Cascade deletes on auth.users handle: conversations, messages, posts,
    // user_documents, profiles (all have ON DELETE CASCADE to auth.users).
    // We just need to delete the auth user record.
    const admin = createAdminClient();
    const { error: deleteErr } = await admin.auth.admin.deleteUser(user.id);

    if (deleteErr) {
      console.error("[account/delete] deleteUser error:", deleteErr.message);
      return json({ error: "Failed to delete account" }, 500);
    }

    return json({ success: true });
  } catch (err) {
    console.error("[account/delete] threw:", err);
    return json({ error: "Internal server error" }, 500);
  }
}
