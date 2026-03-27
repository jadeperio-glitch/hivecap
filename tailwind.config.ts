import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        charcoal: "#0F0F0F",
        gold: "#E8A800",
        "gold-light": "#F5C800",
        "gold-dark": "#C8960A",
        cream: "#F5F2EC",
        muted: "#6B6860",
        border: "#E0DDD6",
        card: "#FDFBF8",
        ink: "#0F0F0F",
      },
      fontFamily: {
        // Space Grotesk is the display/wordmark font per spec
        "space-grotesk": ["var(--font-space-grotesk)", "sans-serif"],
        // Keep 'playfair' alias so existing classes still compile — now maps to Space Grotesk
        playfair: ["var(--font-space-grotesk)", "sans-serif"],
        dmsans: ["var(--font-dmsans)", "sans-serif"],
        dmmono: ["var(--font-dmmono)", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
