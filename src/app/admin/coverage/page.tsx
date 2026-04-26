import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CoverageClient from "./CoverageClient";

export default async function AdminCoveragePage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const adminIds = (process.env.HIVECAP_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!adminIds.includes(user.id)) redirect("/");

  return <CoverageClient />;
}
