import type { Config } from "tailwindcss";

const { fontFamily } = require("tailwindcss/defaultTheme");

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-app)", ...fontFamily.sans],
      },
      colors: {
        slate: {
          ...require('tailwindcss/colors').slate
        },
        zinc: {
          ...require('tailwindcss/colors').zinc
        },
        blue: {
          ...require('tailwindcss/colors').blue
        },
        green: {
          ...require('tailwindcss/colors').green
        },
        red: {
          ...require('tailwindcss/colors').red
        },
        // App-wide brand color, anchored on Apple's HIG systemBlue (#007AFF) at
        // the 600 step to match the convention every other color ramp in this
        // app already uses (600 = default interactive/button shade). This is
        // the ONE primary/accent color for the whole admin app — don't reach
        // for violet/purple/indigo as a second "primary" elsewhere.
        primary: {
          50: "#EFF7FF",
          100: "#DBEDFF",
          200: "#B8DBFF",
          300: "#85C2FF",
          400: "#4DA3FF",
          500: "#1A84FF",
          600: "#007AFF",
          700: "#0062CC",
          800: "#004C9E",
          900: "#073B75",
          950: "#05264D",
        },
        // Apple HIG system colors (light mode), for status/semantic use.
        apple: {
          red: "#FF3B30",
          orange: "#FF9500",
          yellow: "#FFCC00",
          green: "#34C759",
          mint: "#00C7BE",
          teal: "#30B0C7",
          cyan: "#32ADE6",
          blue: "#007AFF",
          indigo: "#5856D6",
          purple: "#AF52DE",
          pink: "#FF2D55",
          brown: "#A2845E",
        },
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
      boxShadow: {
        soft: "0 1px 2px rgba(15, 23, 42, 0.04), 0 8px 20px -6px rgba(15, 23, 42, 0.08)",
        "soft-lg":
          "0 2px 4px rgba(15, 23, 42, 0.04), 0 12px 32px -8px rgba(15, 23, 42, 0.1)",
      },
    },
  },
  plugins: [],
};
export default config;
