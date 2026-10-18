import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Restrained enterprise palette — no gradients, no neon
        ink: "#1a2332",
        slate2: "#334155",
        muted: "#64748b",
        line: "#e2e8f0",
        paper: "#f8fafc",
        accent: "#0f766e",
        warn: "#b45309",
        danger: "#b91c1c",
        ok: "#15803d",
      },
    },
  },
  plugins: [],
};

export default config;
