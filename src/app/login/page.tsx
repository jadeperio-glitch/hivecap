"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(false);
      return;
    }

    router.push("/brain");
    router.refresh();
  }

  return (
    <main className="min-h-screen bg-charcoal flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <Link href="/" className="flex items-center gap-2 mb-10">
        <span className="text-2xl">🐝</span>
        <span className="font-playfair text-2xl font-bold text-gold tracking-wide">
          HiveCap
        </span>
      </Link>

      {/* Card */}
      <div className="w-full max-w-md bg-[#161616] border border-gold/20 rounded-2xl p-8 shadow-2xl shadow-black/50">
        <h1 className="font-playfair text-2xl font-bold text-cream mb-1">
          Welcome back
        </h1>
        <p className="text-cream/50 text-sm mb-8">
          Sign in to access HiveCap Brain
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Email */}
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold text-cream/60 uppercase tracking-wider mb-2"
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
              className="w-full bg-charcoal border border-gold/20 rounded-lg px-4 py-3 text-cream placeholder:text-cream/25 text-sm focus:border-gold/60 focus:ring-1 focus:ring-gold/30 transition-colors duration-200 outline-none"
            />
          </div>

          {/* Password */}
          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold text-cream/60 uppercase tracking-wider mb-2"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              className="w-full bg-charcoal border border-gold/20 rounded-lg px-4 py-3 text-cream placeholder:text-cream/25 text-sm focus:border-gold/60 focus:ring-1 focus:ring-gold/30 transition-colors duration-200 outline-none"
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
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>

        <p className="text-center text-cream/40 text-sm mt-6">
          Don&apos;t have an account?{" "}
          <Link
            href="/signup"
            className="text-gold hover:text-gold/80 font-medium transition-colors"
          >
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
