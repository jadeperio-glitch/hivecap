"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { HiveCapLogo } from "@/components/HiveCapLogo";
import { ThemeToggle } from "@/components/ThemeToggle";

const VALID_INVITE_CODE = "maxplayer";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side invite code validation
    if (inviteCode.trim().toLowerCase() !== VALID_INVITE_CODE) {
      setError("Invalid invite code");
      return;
    }

    setLoading(true);

    // Double-check invite code before creating account
    if (inviteCode.trim().toLowerCase() !== VALID_INVITE_CODE) {
      setError("Invalid invite code");
      setLoading(false);
      return;
    }

    const supabase = createClient();

    const { error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/brain`,
      },
    });

    if (signUpError) {
      setError(signUpError.message);
      setLoading(false);
      return;
    }

    // Sign in immediately after signup
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      // Account created but couldn't auto sign in — redirect to login
      router.push("/login?message=Account created. Please sign in.");
      return;
    }

    router.push("/brain");
    router.refresh();
  }

  return (
    <main className="relative min-h-screen bg-cream dark:bg-charcoal flex flex-col items-center justify-center px-4">
      {/* Theme toggle */}
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>

      {/* Logo */}
      <Link href="/" className="mb-10">
        <HiveCapLogo size="md" />
      </Link>

      {/* Card */}
      <div className="w-full max-w-md bg-white dark:bg-[#161616] border border-gold/20 rounded-2xl p-8 shadow-2xl shadow-black/10 dark:shadow-black/50">
        <h1 className="font-playfair text-2xl font-bold text-charcoal dark:text-cream mb-1">
          Request Access
        </h1>
        <p className="text-charcoal/50 dark:text-cream/50 text-sm mb-8">
          An invite code is required to create an account
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Email */}
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold text-charcoal/60 dark:text-cream/60 uppercase tracking-wider mb-2"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="you@example.com"
              className="w-full bg-cream dark:bg-charcoal border border-gold/20 rounded-lg px-4 py-3 text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 text-sm focus:border-gold/60 focus:ring-1 focus:ring-gold/30 transition-colors duration-200 outline-none"
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold text-charcoal/60 dark:text-cream/60 uppercase tracking-wider mb-2"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              placeholder="Min. 6 characters"
              className="w-full bg-cream dark:bg-charcoal border border-gold/20 rounded-lg px-4 py-3 text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 text-sm focus:border-gold/60 focus:ring-1 focus:ring-gold/30 transition-colors duration-200 outline-none"
            />
          </div>

          {/* Invite Code */}
          <div>
            <label
              htmlFor="inviteCode"
              className="block text-xs font-semibold text-charcoal/60 dark:text-cream/60 uppercase tracking-wider mb-2"
            >
              Invite Code
            </label>
            <input
              id="inviteCode"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
              placeholder="Enter your invite code"
              className="w-full bg-cream dark:bg-charcoal border border-gold/20 rounded-lg px-4 py-3 text-charcoal dark:text-cream placeholder:text-charcoal/25 dark:placeholder:text-cream/25 text-sm focus:border-gold/60 focus:ring-1 focus:ring-gold/30 transition-colors duration-200 outline-none"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-900/30 border border-red-500/40 rounded-lg px-4 py-3">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-gold text-charcoal py-3 rounded-lg font-semibold text-sm hover:bg-gold/90 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 shadow-lg shadow-gold/20 mt-2"
          >
            {loading ? "Creating account…" : "Create Account"}
          </button>
        </form>

        <p className="text-center text-charcoal/40 dark:text-cream/40 text-sm mt-6">
          Already have an account?{" "}
          <Link
            href="/login"
            className="text-gold hover:text-gold/80 font-medium transition-colors"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
