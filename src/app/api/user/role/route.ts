import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

// GET /api/user/role — returns { isAdmin: boolean } for the current authenticated user.
// Used by client components that need to adjust UI for admin accounts.
export async function GET() {
  try {
    const supabase = createClient();
    const { data: { user }, error } = await supabase.auth.getUser();

    if (error || !user) {
      return new Response(JSON.stringify({ isAdmin: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const adminIds = (process.env.HIVECAP_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return new Response(JSON.stringify({ isAdmin: adminIds.includes(user.id) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ isAdmin: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}
