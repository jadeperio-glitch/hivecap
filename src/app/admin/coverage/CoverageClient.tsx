"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

interface Track {
  id: string;
  name: string;
  abbreviation: string | null;
}

interface MarkedRace {
  race_id: string;
  track_name: string;
  race_date: string;
  race_number: number;
  expected_field_size: number;
  performance_count: number;
  fully_covered: boolean;
  coverage_marked_at: string | null;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export default function CoverageClient() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [markedRaces, setMarkedRaces] = useState<MarkedRace[]>([]);
  const [loadingRaces, setLoadingRaces] = useState(true);

  const [trackId, setTrackId] = useState("");
  const [raceDate, setRaceDate] = useState(new Date().toISOString().split("T")[0]);
  const [raceNumber, setRaceNumber] = useState("");
  const [expectedFieldSize, setExpectedFieldSize] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ success: boolean; message: string } | null>(null);

  const [unmarking, setUnmarking] = useState<string | null>(null);

  const fetchMarkedRaces = useCallback(async () => {
    setLoadingRaces(true);
    try {
      const res = await fetch("/api/admin/coverage");
      if (res.ok) setMarkedRaces(await res.json());
    } finally {
      setLoadingRaces(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("tracks")
      .select("id, name, abbreviation")
      .order("name", { ascending: true })
      .then(({ data }) => {
        if (data) setTracks(data);
      });

    fetchMarkedRaces();
  }, [fetchMarkedRaces]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!trackId || !raceDate || !raceNumber || !expectedFieldSize) return;
    setSubmitting(true);
    setSubmitResult(null);

    try {
      const res = await fetch("/api/admin/coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          track_id: trackId,
          race_date: raceDate,
          race_number: parseInt(raceNumber, 10),
          expected_field_size: parseInt(expectedFieldSize, 10),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      setSubmitResult({
        success: true,
        message: `Marked. ${data.performance_count}/${data.expected_field_size} horses seeded. Status: ${data.fully_covered ? "Covered" : "Partial"}`,
      });
      setRaceNumber("");
      setExpectedFieldSize("");
      await fetchMarkedRaces();
    } catch (err) {
      setSubmitResult({ success: false, message: err instanceof Error ? err.message : "Failed" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUnmark(raceId: string) {
    setUnmarking(raceId);
    try {
      const res = await fetch("/api/admin/coverage", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ race_id: raceId }),
      });
      if (res.ok) await fetchMarkedRaces();
    } finally {
      setUnmarking(null);
    }
  }

  return (
    <div className="min-h-screen bg-charcoal text-cream px-4 py-8">
      <div className="max-w-3xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold text-gold">Admin — Race Coverage</h1>
          <p className="text-cream/50 text-sm mt-1">
            Mark races as fully seeded so users uploading the same PDF skip extraction.
          </p>
        </div>

        {/* Mark coverage form */}
        <section className="bg-[#111] border border-gold/15 rounded-2xl p-6">
          <h2 className="text-base font-semibold text-cream mb-4">Mark Race Coverage Complete</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-cream/50 mb-1.5">Track</label>
                <select
                  value={trackId}
                  onChange={(e) => setTrackId(e.target.value)}
                  required
                  className="w-full bg-[#1a1a1a] border border-cream/10 rounded-lg px-3 py-2 text-sm text-cream focus:border-gold/40 outline-none"
                >
                  <option value="">Select track…</option>
                  {tracks.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.abbreviation ? ` (${t.abbreviation})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-cream/50 mb-1.5">Race Date</label>
                <input
                  type="date"
                  value={raceDate}
                  onChange={(e) => setRaceDate(e.target.value)}
                  required
                  className="w-full bg-[#1a1a1a] border border-cream/10 rounded-lg px-3 py-2 text-sm text-cream focus:border-gold/40 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-cream/50 mb-1.5">Race Number (1–14)</label>
                <input
                  type="number"
                  min={1}
                  max={14}
                  value={raceNumber}
                  onChange={(e) => setRaceNumber(e.target.value)}
                  required
                  placeholder="e.g. 12"
                  className="w-full bg-[#1a1a1a] border border-cream/10 rounded-lg px-3 py-2 text-sm text-cream focus:border-gold/40 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-cream/50 mb-1.5">Expected Field Size (2–20)</label>
                <input
                  type="number"
                  min={2}
                  max={20}
                  value={expectedFieldSize}
                  onChange={(e) => setExpectedFieldSize(e.target.value)}
                  required
                  placeholder="e.g. 20"
                  className="w-full bg-[#1a1a1a] border border-cream/10 rounded-lg px-3 py-2 text-sm text-cream focus:border-gold/40 outline-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={submitting || !trackId || !raceDate || !raceNumber || !expectedFieldSize}
                className="bg-gold text-charcoal text-sm font-semibold px-5 py-2 rounded-lg hover:bg-gold/85 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
              >
                {submitting ? "Marking…" : "Mark Coverage Complete"}
              </button>
              {submitResult && (
                <p className={`text-sm ${submitResult.success ? "text-green-400" : "text-red-400"}`}>
                  {submitResult.message}
                </p>
              )}
            </div>
          </form>
        </section>

        {/* Marked races table */}
        <section className="bg-[#111] border border-gold/15 rounded-2xl p-6">
          <h2 className="text-base font-semibold text-cream mb-4">Currently Marked Races</h2>
          {loadingRaces ? (
            <p className="text-cream/30 text-sm">Loading…</p>
          ) : markedRaces.length === 0 ? (
            <p className="text-cream/30 text-sm">No races marked yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-cream/40 text-xs border-b border-cream/10">
                    <th className="text-left pb-2 pr-4 font-medium">Track</th>
                    <th className="text-left pb-2 pr-4 font-medium">Date</th>
                    <th className="text-left pb-2 pr-4 font-medium">Race #</th>
                    <th className="text-left pb-2 pr-4 font-medium">Field</th>
                    <th className="text-left pb-2 pr-4 font-medium">Seeded</th>
                    <th className="text-left pb-2 pr-4 font-medium">Status</th>
                    <th className="pb-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {markedRaces.map((r) => (
                    <tr key={r.race_id} className="border-b border-cream/5">
                      <td className="py-2.5 pr-4 text-cream/80">{r.track_name}</td>
                      <td className="py-2.5 pr-4 text-cream/60">{formatDate(r.race_date)}</td>
                      <td className="py-2.5 pr-4 text-cream/60">{r.race_number}</td>
                      <td className="py-2.5 pr-4 text-cream/60">{r.expected_field_size}</td>
                      <td className="py-2.5 pr-4 text-cream/60">{r.performance_count}</td>
                      <td className="py-2.5 pr-4">
                        {r.fully_covered ? (
                          <span className="inline-flex items-center gap-1 bg-green-500/15 border border-green-500/30 text-green-400 rounded-full px-2.5 py-0.5 text-xs font-medium">
                            Covered
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 bg-gold/15 border border-gold/30 text-gold rounded-full px-2.5 py-0.5 text-xs font-medium">
                            Partial {r.performance_count}/{r.expected_field_size}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => handleUnmark(r.race_id)}
                          disabled={unmarking === r.race_id}
                          className="text-xs text-cream/30 hover:text-red-400 transition-colors disabled:opacity-40"
                        >
                          {unmarking === r.race_id ? "…" : "Unmark"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="text-cream/20 text-xs text-center">
          <a href="/brain" className="hover:text-cream/40 transition-colors">← Back to Brain</a>
        </p>
      </div>
    </div>
  );
}
