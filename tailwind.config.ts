import type { Config } from "tailwindcss";

const { fontFamily } = require("tailwindcss/defaultTheme");

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "!./app/(admin)/settings/page.tsx",
    "!./app/(admin)/invoices/page.tsx",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-sarabun)", ...fontFamily.sans],
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
        }
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
};
export default config;
