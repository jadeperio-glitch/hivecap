"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { HiveCapLogo } from "@/components/HiveCapLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

interface UserDocument {
  id: string;
  filename: string;
  created_at: string;
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white dark:bg-[#111] border border-gold/15 rounded-2xl p-6 shadow-sm">
      <h2 className="font-playfair text-lg font-bold text-charcoal dark:text-cream mb-5">
        {title}
      </h2>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="block text-xs font-semibold text-charcoal/50 dark:text-cream/50 uppercase tracking-wider">
        {label}
      </label>
      {children}
    </div>
  );
}

const inputCls =
  "w-full bg-cream dark:bg-charcoal border border-gold/20 rounded-lg px-4 py-2.5 text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 text-sm focus:border-gold/50 focus:ring-1 focus:ring-gold/20 transition-colors outline-none";

export default function SettingsPage() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // ── Identity ──────────────────────────────────────────────────────────────
  const [currentUsername, setCurrentUsername] = useState<string | null>(null);
  const [usernameEdit, setUsernameEdit] = useState("");
  const [usernameEditing, setUsernameEditing] = useState(false);
  const [usernameSaving, setUsernameSaving] = useState(false);
  const [usernameMsg, setUsernameMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  // ── Brain / Documents ──────────────────────────────────────────────────────
  const [documents, setDocuments] = useState<UserDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false);
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);

  // ── Account ───────────────────────────────────────────────────────────────
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteAccountBusy, setDeleteAccountBusy] = useState(false);
  const [deleteAccountErr, setDeleteAccountErr] = useState<string | null>(null);

  const fetchDocs = useCallback(async () => {
    setDocsLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("user_documents")
      .select("id, filename, created_at")
      .order("created_at", { ascending: false });
    if (data) setDocuments(data);
    setDocsLoading(false);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) {
        router.push("/login");
        return;
      }
      setUserEmail(user.email ?? null);
      setUserId(user.id);

      // Load profile
      const { data: profile } = await supabase
        .from("profiles")
        .select("username")
        .eq("id", user.id)
        .maybeSingle();
      setCurrentUsername(profile?.username ?? null);
      setUsernameEdit(profile?.username ?? "");

      fetchDocs();
    });
  }, [router, fetchDocs]);

  // ── Username save ──────────────────────────────────────────────────────────
  async function saveUsername() {
    const trimmed = usernameEdit.trim();
    if (!trimmed) return;
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(trimmed)) {
      setUsernameMsg({ type: "err", text: "3–20 chars, letters/numbers/underscores only" });
      return;
    }
    setUsernameSaving(true);
    setUsernameMsg(null);
    const supabase = createClient();
    const { error } = await supabase
      .from("profiles")
      .upsert({ id: userId!, username: trimmed }, { onConflict: "id" });
    if (error) {
      const msg = error.message.includes("unique") || error.code === "23505"
        ? "That username is already taken"
        : error.message;
      setUsernameMsg({ type: "err", text: msg });
    } else {
      setCurrentUsername(trimmed);
      setUsernameEditing(false);
      setUsernameMsg({ type: "ok", text: "Username updated" });
      setTimeout(() => setUsernameMsg(null), 3000);
    }
    setUsernameSaving(false);
  }

  // ── Password change ────────────────────────────────────────────────────────
  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!currentPw || !newPw) return;
    if (newPw.length < 6) {
      setPwMsg({ type: "err", text: "New password must be at least 6 characters" });
      return;
    }
    setPwSaving(true);
    setPwMsg(null);
    const supabase = createClient();

    // Re-authenticate with current password to verify it
    const { error: signInErr } = await supabase.auth.signInWithPassword({
      email: userEmail!,
      password: currentPw,
    });
    if (signInErr) {
      setPwMsg({ type: "err", text: "Current password is incorrect" });
      setPwSaving(false);
      return;
    }

    const { error: updateErr } = await supabase.auth.updateUser({ password: newPw });
    if (updateErr) {
      setPwMsg({ type: "err", text: updateErr.message });
    } else {
      setPwMsg({ type: "ok", text: "Password updated" });
      setCurrentPw("");
      setNewPw("");
      setTimeout(() => setPwMsg(null), 3000);
    }
    setPwSaving(false);
  }

  // ── Delete single doc ──────────────────────────────────────────────────────
  async function deleteDoc(docId: string) {
    setDeletingDocId(docId);
    const supabase = createClient();
    await supabase.from("user_documents").delete().eq("id", docId).eq("user_id", userId!);
    setDocuments((prev) => prev.filter((d) => d.id !== docId));
    setDeletingDocId(null);
  }

  // ── Delete all docs ────────────────────────────────────────────────────────
  async function deleteAllDocs() {
    setDeleteAllBusy(true);
    const supabase = createClient();
    await supabase.from("user_documents").delete().eq("user_id", userId!);
    setDocuments([]);
    setDeleteAllConfirm(false);
    setDeleteAllBusy(false);
  }

  // ── Delete account ─────────────────────────────────────────────────────────
  async function deleteAccount() {
    setDeleteAccountBusy(true);
    setDeleteAccountErr(null);
    const res = await fetch("/api/account/delete", { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setDeleteAccountErr(data.error ?? "Failed to delete account");
      setDeleteAccountBusy(false);
      return;
    }
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
  }

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-cream dark:bg-charcoal">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gold/20 bg-white dark:bg-[#0a0a0a] px-4 md:px-6 py-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HiveCapLogo size="sm" markOnly />
            <h1 className="font-playfair text-lg font-bold text-charcoal dark:text-cream leading-none">
              Settings
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <a
              href="/brain"
              className="flex items-center gap-1.5 text-charcoal/60 hover:text-gold dark:text-cream/60 dark:hover:text-gold text-sm font-medium border border-charcoal/10 hover:border-gold/40 dark:border-cream/10 dark:hover:border-gold/40 rounded-lg px-3 py-2 transition-all duration-200"
            >
              Brain
            </a>
            <button
              onClick={handleLogout}
              className="flex items-center gap-1.5 text-charcoal/50 hover:text-charcoal/80 dark:text-cream/50 dark:hover:text-cream/80 text-sm font-medium border border-charcoal/10 hover:border-charcoal/20 dark:border-cream/10 dark:hover:border-cream/20 rounded-lg px-3 py-2 transition-all duration-200"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="px-4 md:px-6 py-8">
        <div className="max-w-2xl mx-auto space-y-6">

          {/* ── Section 1: Identity ─────────────────────────────────────────── */}
          <SectionCard title="Identity">
            <div className="space-y-5">
              {/* Username */}
              <Field label="Username">
                {usernameEditing ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={usernameEdit}
                      onChange={(e) => setUsernameEdit(e.target.value)}
                      className={inputCls + " flex-1"}
                      placeholder="3–20 chars"
                      maxLength={20}
                      autoFocus
                    />
                    <button
                      onClick={saveUsername}
                      disabled={usernameSaving}
                      className="bg-gold text-charcoal text-sm font-semibold px-4 py-2 rounded-lg hover:bg-gold/85 disabled:opacity-40 transition-all"
                    >
                      {usernameSaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      onClick={() => {
                        setUsernameEditing(false);
                        setUsernameEdit(currentUsername ?? "");
                        setUsernameMsg(null);
                      }}
                      className="text-sm text-charcoal/50 hover:text-charcoal/80 dark:text-cream/50 dark:hover:text-cream/80 border border-charcoal/10 dark:border-cream/10 rounded-lg px-3 py-2 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-charcoal dark:text-cream">
                      {currentUsername ?? <span className="text-charcoal/35 dark:text-cream/35 italic">No username set</span>}
                    </span>
                    <button
                      onClick={() => { setUsernameEditing(true); setUsernameMsg(null); }}
                      className="text-xs text-gold hover:text-gold/75 font-medium transition-colors"
                    >
                      Edit
                    </button>
                  </div>
                )}
                {usernameMsg && (
                  <p className={`text-xs mt-1 ${usernameMsg.type === "ok" ? "text-green-500" : "text-red-400"}`}>
                    {usernameMsg.text}
                  </p>
                )}
              </Field>

              {/* Email (read-only) */}
              <Field label="Email">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-charcoal/60 dark:text-cream/60">
                    {userEmail ?? "—"}
                  </span>
                  <span className="text-xs text-charcoal/30 dark:text-cream/30 border border-charcoal/10 dark:border-cream/10 rounded px-1.5 py-0.5">
                    read-only
                  </span>
                </div>
              </Field>

              {/* Divider */}
              <div className="border-t border-gold/10 pt-4">
                <p className="text-xs font-semibold text-charcoal/50 dark:text-cream/50 uppercase tracking-wider mb-4">
                  Change Password
                </p>
                <form onSubmit={changePassword} className="space-y-3">
                  <input
                    type="password"
                    value={currentPw}
                    onChange={(e) => setCurrentPw(e.target.value)}
                    placeholder="Current password"
                    className={inputCls}
                  />
                  <input
                    type="password"
                    value={newPw}
                    onChange={(e) => setNewPw(e.target.value)}
                    placeholder="New password (min. 6 characters)"
                    className={inputCls}
                  />
                  {pwMsg && (
                    <p className={`text-xs ${pwMsg.type === "ok" ? "text-green-500" : "text-red-400"}`}>
                      {pwMsg.text}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={pwSaving || !currentPw || !newPw}
                    className="bg-gold text-charcoal text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gold/85 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                  >
                    {pwSaving ? "Updating…" : "Update Password"}
                  </button>
                </form>
              </div>
            </div>
          </SectionCard>

          {/* ── Section 2: Brain ────────────────────────────────────────────── */}
          <SectionCard title="Brain">
            {docsLoading ? (
              <p className="text-sm text-charcoal/40 dark:text-cream/40">Loading documents…</p>
            ) : documents.length === 0 ? (
              <p className="text-sm text-charcoal/40 dark:text-cream/40">No documents uploaded yet.</p>
            ) : (
              <div className="space-y-3">
                {documents.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center justify-between gap-3 py-2.5 border-b border-gold/10 last:border-0"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <svg className="w-4 h-4 text-gold/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      <span className="text-sm text-charcoal dark:text-cream truncate">{doc.filename}</span>
                      <span className="text-xs text-charcoal/30 dark:text-cream/30 flex-shrink-0">{timeAgo(doc.created_at)}</span>
                    </div>
                    <button
                      onClick={() => deleteDoc(doc.id)}
                      disabled={deletingDocId === doc.id}
                      className="flex-shrink-0 text-xs text-red-400 hover:text-red-500 disabled:opacity-40 transition-colors font-medium"
                    >
                      {deletingDocId === doc.id ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                ))}

                {/* Delete All */}
                <div className="pt-3">
                  {deleteAllConfirm ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-charcoal/50 dark:text-cream/50">
                        Delete all {documents.length} documents?
                      </span>
                      <button
                        onClick={deleteAllDocs}
                        disabled={deleteAllBusy}
                        className="text-xs text-red-500 hover:text-red-600 font-semibold disabled:opacity-40 transition-colors"
                      >
                        {deleteAllBusy ? "Deleting…" : "Yes, delete all"}
                      </button>
                      <button
                        onClick={() => setDeleteAllConfirm(false)}
                        className="text-xs text-charcoal/40 dark:text-cream/40 hover:text-charcoal/70 dark:hover:text-cream/70 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteAllConfirm(true)}
                      className="text-sm text-red-400 hover:text-red-500 font-medium border border-red-400/20 hover:border-red-400/40 rounded-lg px-4 py-2 transition-all"
                    >
                      Delete All Documents
                    </button>
                  )}
                </div>
              </div>
            )}
          </SectionCard>

          {/* ── Section 3: Account ──────────────────────────────────────────── */}
          <SectionCard title="Account">
            <div>
              <p className="text-sm text-charcoal/50 dark:text-cream/50 mb-4">
                Permanently delete your account and all associated data. This cannot be undone.
              </p>
              <button
                onClick={() => { setShowDeleteModal(true); setDeleteConfirmText(""); setDeleteAccountErr(null); }}
                className="text-sm text-red-400 hover:text-red-500 font-medium border border-red-400/20 hover:border-red-400/40 rounded-lg px-4 py-2 transition-all"
              >
                Delete Account
              </button>
            </div>
          </SectionCard>

        </div>
      </main>

      {/* ── Delete Account Modal ─────────────────────────────────────────────── */}
      {showDeleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget && !deleteAccountBusy) setShowDeleteModal(false); }}
        >
          <div className="bg-white dark:bg-[#111] border border-red-500/20 rounded-2xl shadow-2xl w-full max-w-md p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-9 h-9 rounded-full bg-red-500/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
              </div>
              <div>
                <h2 className="font-playfair text-base font-bold text-charcoal dark:text-cream">
                  Delete Account
                </h2>
                <p className="text-sm text-charcoal/60 dark:text-cream/60 mt-1">
                  This will permanently delete your account and all data — documents, posts, conversations, messages, and profile. This cannot be undone.
                </p>
              </div>
            </div>

            <div className="mb-4">
              <label className="block text-xs font-semibold text-charcoal/50 dark:text-cream/50 uppercase tracking-wider mb-2">
                Type <span className="text-red-400 font-mono">DELETE</span> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
                disabled={deleteAccountBusy}
                className={inputCls}
              />
            </div>

            {deleteAccountErr && (
              <p className="text-red-400 text-xs mb-3">{deleteAccountErr}</p>
            )}

            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowDeleteModal(false)}
                disabled={deleteAccountBusy}
                className="text-sm text-charcoal/50 hover:text-charcoal/80 dark:text-cream/50 dark:hover:text-cream/80 border border-charcoal/10 dark:border-cream/10 rounded-lg px-4 py-2 transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={deleteAccount}
                disabled={deleteConfirmText !== "DELETE" || deleteAccountBusy}
                className="bg-red-500 hover:bg-red-600 text-white text-sm font-semibold px-5 py-2 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                {deleteAccountBusy ? "Deleting…" : "Delete My Account"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
