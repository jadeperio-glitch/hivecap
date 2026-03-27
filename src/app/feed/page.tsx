"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { HiveCapLogo } from "@/components/HiveCapLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

interface Post {
  id: string;
  user_email: string;
  content: string;
  brain_verified: boolean;
  project_id: string | null;
  conversation_id: string | null;
  created_at: string;
}

interface Project {
  id: string;
  name: string;
}

function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function PostCard({ post }: { post: Post }) {
  return (
    <article className="bg-white dark:bg-[#111] border border-gold/15 rounded-2xl px-5 py-4 shadow-sm">
      <div className="flex items-center justify-between mb-2 gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-charcoal/50 dark:text-cream/50 truncate">
            {post.user_email}
          </span>
          {post.brain_verified && (
            <span className="inline-flex items-center gap-1 bg-gold/15 border border-gold/30 text-gold rounded-full px-2 py-0.5 text-xs font-medium flex-shrink-0">
              🐝 Brain
            </span>
          )}
        </div>
        <span className="text-xs text-charcoal/30 dark:text-cream/30 flex-shrink-0">
          {timeAgo(post.created_at)}
        </span>
      </div>
      <p className="text-sm text-charcoal/90 dark:text-cream/90 leading-relaxed whitespace-pre-wrap">
        {post.content}
      </p>
    </article>
  );
}

export default function FeedPage() {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoadingPosts, setIsLoadingPosts] = useState(true);

  // Compose state
  const [content, setContent] = useState("");
  const [brainVerified, setBrainVerified] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const MAX_CHARS = 2000;

  const fetchPosts = useCallback(async () => {
    setIsLoadingPosts(true);
    const res = await fetch("/api/posts");
    if (res.ok) {
      const data = await res.json();
      setPosts(data.posts ?? []);
    }
    setIsLoadingPosts(false);
  }, []);

  const fetchProjects = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("projects")
      .select("id, name")
      .order("created_at", { ascending: false });
    if (data) setProjects(data);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (!user) {
        router.push("/login");
      } else {
        setUserEmail(user.email ?? null);
        fetchPosts();
        fetchProjects();
      }
    });
  }, [router, fetchPosts, fetchProjects]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim() || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: content.trim(),
          brain_verified: brainVerified,
          project_id: selectedProjectId || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setContent("");
      setBrainVerified(false);
      setSelectedProjectId("");
      await fetchPosts();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to post");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleLogout() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="flex flex-col min-h-screen bg-cream dark:bg-charcoal">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gold/20 bg-white dark:bg-[#0a0a0a] px-4 md:px-6 py-4 sticky top-0 z-10">
        <div className="max-w-2xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HiveCapLogo size="sm" markOnly />
            <div>
              <h1 className="font-playfair text-lg font-bold text-charcoal dark:text-cream leading-none">
                Community Feed
              </h1>
              {userEmail && (
                <p className="text-charcoal/35 dark:text-cream/35 text-xs mt-0.5 truncate max-w-[200px]">
                  {userEmail}
                </p>
              )}
            </div>
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

      <main className="flex-1 px-4 md:px-6 py-6">
        <div className="max-w-2xl mx-auto space-y-6">

          {/* Compose box */}
          <form
            onSubmit={handleSubmit}
            className="bg-white dark:bg-[#111] border border-gold/20 rounded-2xl p-4 shadow-sm"
          >
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Share a pick, analysis, or race note…"
              rows={3}
              maxLength={MAX_CHARS}
              className="w-full bg-transparent text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 text-sm resize-none leading-relaxed outline-none"
            />

            <div className="flex items-center justify-between mt-3 flex-wrap gap-2">
              <div className="flex items-center gap-3 flex-wrap">
                {/* Brain-verified toggle */}
                <label className="flex items-center gap-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={brainVerified}
                    onChange={(e) => setBrainVerified(e.target.checked)}
                    className="w-3.5 h-3.5 accent-gold"
                  />
                  <span className="text-xs text-charcoal/60 dark:text-cream/60">
                    🐝 Brain-verified
                  </span>
                </label>

                {/* Project selector */}
                {projects.length > 0 && (
                  <select
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                    className="text-xs bg-transparent border border-gold/20 rounded-lg px-2 py-1 text-charcoal/70 dark:text-cream/70 outline-none focus:border-gold/50"
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2">
                <span className={`text-xs ${content.length > MAX_CHARS * 0.9 ? "text-red-400" : "text-charcoal/25 dark:text-cream/25"}`}>
                  {content.length}/{MAX_CHARS}
                </span>
                <button
                  type="submit"
                  disabled={!content.trim() || isSubmitting || content.length > MAX_CHARS}
                  className="bg-gold text-charcoal text-sm font-semibold px-4 py-1.5 rounded-lg hover:bg-gold/85 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 shadow-sm shadow-gold/20"
                >
                  {isSubmitting ? "Posting…" : "Post"}
                </button>
              </div>
            </div>

            {submitError && (
              <p className="text-red-500 text-xs mt-2">{submitError}</p>
            )}
          </form>

          {/* Posts */}
          {isLoadingPosts ? (
            <div className="flex items-center justify-center py-12 text-charcoal/30 dark:text-cream/30 text-sm">
              Loading feed…
            </div>
          ) : posts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-charcoal/40 dark:text-cream/40 text-sm">No posts yet.</p>
              <p className="text-charcoal/25 dark:text-cream/25 text-xs mt-1">Be the first to share a pick.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {posts.map((post) => (
                <PostCard key={post.id} post={post} />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
