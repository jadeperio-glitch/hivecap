import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-charcoal flex flex-col">
      {/* Header */}
      <header className="border-b border-gold/20 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🐝</span>
            <span className="font-playfair text-xl font-bold text-gold tracking-wide">
              HiveCap
            </span>
          </div>
          <nav className="flex items-center gap-4">
            <Link
              href="/login"
              className="text-cream/70 hover:text-cream text-sm font-medium transition-colors duration-200"
            >
              Sign In
            </Link>
            <Link
              href="/signup"
              className="bg-gold text-charcoal px-4 py-2 rounded-md text-sm font-semibold hover:bg-gold/90 transition-colors duration-200"
            >
              Get Access
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
        <div className="max-w-3xl mx-auto">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 bg-gold/10 border border-gold/30 rounded-full px-4 py-1.5 mb-8">
            <span className="text-gold text-xs font-semibold uppercase tracking-widest">
              AI-Powered Racing Intelligence
            </span>
          </div>

          {/* Heading */}
          <h1 className="font-playfair text-5xl md:text-7xl font-bold text-cream leading-tight mb-6">
            The Edge Every{" "}
            <span className="text-gold">Handicapper</span>{" "}
            Needs
          </h1>

          <p className="text-cream/60 text-lg md:text-xl leading-relaxed mb-12 max-w-2xl mx-auto">
            HiveCap Brain synthesizes Beyer Speed Figures, pace analysis,
            pedigree research, and wagering strategy — powered by AI trained on
            the deepest racing data available.
          </p>

          {/* CTA Buttons */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="w-full sm:w-auto bg-gold text-charcoal px-8 py-3.5 rounded-md font-semibold text-base hover:bg-gold/90 transition-all duration-200 shadow-lg shadow-gold/20"
            >
              Get Access →
            </Link>
            <Link
              href="/login"
              className="w-full sm:w-auto border border-gold/30 text-cream px-8 py-3.5 rounded-md font-semibold text-base hover:border-gold/60 hover:bg-gold/5 transition-all duration-200"
            >
              Sign In
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-gold/10 px-6 py-16">
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
          {[
            {
              icon: "📊",
              title: "Speed & Pace",
              desc: "Beyer Speed Figures, pace shapes, and trip notes analyzed in seconds.",
            },
            {
              icon: "🏇",
              title: "2026 Derby",
              desc: "Real-time insights on contenders, connections, and track conditions.",
            },
            {
              icon: "🎯",
              title: "Wagering Strategy",
              desc: "Exactas, trifectas, Pick 4/5/6 — structured approaches for every meet.",
            },
          ].map((feature) => (
            <div
              key={feature.title}
              className="bg-gold/5 border border-gold/15 rounded-xl p-6 hover:border-gold/30 transition-colors duration-200"
            >
              <div className="text-3xl mb-3">{feature.icon}</div>
              <h3 className="font-playfair text-lg font-semibold text-cream mb-2">
                {feature.title}
              </h3>
              <p className="text-cream/50 text-sm leading-relaxed">
                {feature.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gold/10 px-6 py-6 text-center">
        <p className="text-cream/30 text-xs">
          © 2026 HiveCap. All rights reserved.
        </p>
      </footer>
    </main>
  );
}
