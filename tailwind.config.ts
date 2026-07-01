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
        }
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
