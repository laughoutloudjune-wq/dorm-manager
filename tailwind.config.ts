import type { Config } from "tailwindcss";

const { fontFamily } = require("tailwindcss/defaultTheme");
const colors = require("tailwindcss/colors");

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

      // Type scale, rebuilt on Apple's SF text styles and shifted up one step
      // from Tailwind's defaults — the old scale ran small for a data-dense
      // admin UI (14px body, 12px captions).
      //
      //   xs 13  footnote      base 17  body        2xl 28  title1
      //   sm 15  subheadline   lg   19  headline    3xl 34  largeTitle
      //                        xl   22  title2
      //
      // Line heights are deliberately generous: Thai stacks vowels above and
      // tone marks above those, so the tight leading Latin can get away with
      // makes Thai collide. Tracking tightens as size grows, mimicking SF's
      // optical sizing (SF Display is cut tighter than SF Text).
      fontSize: {
        "2xs": ["0.75rem", { lineHeight: "1rem", letterSpacing: "0.005em" }], // 12
        xs: ["0.8125rem", { lineHeight: "1.125rem", letterSpacing: "0.005em" }], // 13
        sm: ["0.9375rem", { lineHeight: "1.375rem" }], // 15
        base: ["1.0625rem", { lineHeight: "1.625rem" }], // 17
        lg: ["1.1875rem", { lineHeight: "1.75rem", letterSpacing: "-0.01em" }], // 19
        xl: ["1.375rem", { lineHeight: "1.875rem", letterSpacing: "-0.015em" }], // 22
        "2xl": ["1.75rem", { lineHeight: "2.25rem", letterSpacing: "-0.02em" }], // 28
        "3xl": ["2.125rem", { lineHeight: "2.5rem", letterSpacing: "-0.025em" }], // 34
        "4xl": ["2.5rem", { lineHeight: "2.75rem", letterSpacing: "-0.03em" }], // 40
        "5xl": ["3.25rem", { lineHeight: "3.5rem", letterSpacing: "-0.03em" }], // 52
      },
      colors: {
        slate: { ...colors.slate },
        zinc: { ...colors.zinc },
        blue: { ...colors.blue },
        green: { ...colors.green },
        red: { ...colors.red },

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

        // ONE ramp per meaning. Before these existed the codebase forked three
        // ways per concept (emerald AND green, amber AND yellow AND orange,
        // red AND rose, blue AND indigo AND cyan AND sky) — the same status
        // could render a different color depending on which file drew it. Use
        // these semantic names rather than the underlying palette names, so
        // the intent is legible at the call site and there is exactly one
        // place to edit if the palette moves.
        success: { ...colors.emerald },
        warning: { ...colors.amber },
        danger: { ...colors.red },

        // Apple HIG system colors (light mode). Reserved for the dashboard KPI
        // tints, where each hue carries a documented meaning beyond the three
        // semantic states above. Not for general UI chrome.
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

      // Three sizes, semantically named, so a "card" is the same roundness
      // everywhere. Tailwind's numeric scale stays available for one-offs but
      // new code should reach for these.
      borderRadius: {
        control: "0.75rem", // 12px — buttons, inputs, chips, table controls
        card: "1.125rem", // 18px — cards, panels, list surfaces
        panel: "1.5rem", // 24px — modals and other large floating surfaces
      },

      // The "floating" elevation scale. Every level is a two-layer shadow: a
      // tight contact shadow for the edge, plus a wide, very low-opacity cast
      // for the lift. Pick a level by role, not by taste:
      //   float     resting cards and panels
      //   float-md  hover state of an interactive card, sticky headers
      //   float-lg  popovers, dropdowns, floating toolbars, the sidebar
      //   float-xl  modals
      boxShadow: {
        float:
          "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 12px -2px rgba(15, 23, 42, 0.06)",
        "float-md":
          "0 1px 2px rgba(15, 23, 42, 0.04), 0 10px 24px -6px rgba(15, 23, 42, 0.10)",
        "float-lg":
          "0 2px 4px rgba(15, 23, 42, 0.04), 0 20px 40px -12px rgba(15, 23, 42, 0.14)",
        "float-xl":
          "0 8px 16px rgba(15, 23, 42, 0.06), 0 32px 64px -16px rgba(15, 23, 42, 0.20)",
        // Aliases of the two lowest float levels. A large number of call sites
        // still name these, and they must not drift away from the scale.
        soft: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 12px -2px rgba(15, 23, 42, 0.06)",
        "soft-lg":
          "0 1px 2px rgba(15, 23, 42, 0.04), 0 10px 24px -6px rgba(15, 23, 42, 0.10)",
      },

      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },

      transitionTimingFunction: {
        // Decelerate curve used by every hover/enter transition, so motion
        // across the app reads as coming from one system.
        float: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
export default config;
