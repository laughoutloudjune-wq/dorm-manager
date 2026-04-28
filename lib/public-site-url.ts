/**
 * HTTPS origin for links embedded in LINE Flex messages, slip notifications, etc.
 *
 * **Local + LINE:** the app may run on `http://localhost:3000` while payment links in
 * messages must be a public HTTPS host (usually your Vercel deployment). Set
 * `INVOICE_PUBLIC_BASE_URL` in `.env.local` to that URL; `NEXT_PUBLIC_BASE_URL` can stay
 * `localhost` for the rest of the app. Values that only work on your machine (localhost,
 * ngrok, etc.) are skipped so they are never used for Flex URIs.
 *
 * **Production / Vercel:** set `NEXT_PUBLIC_BASE_URL` to your canonical URL, or omit it
 * and use `VERCEL_URL` (e.g. `https://xxx.vercel.app`).
 */

function normalizeOrigin(raw: string): string {
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProto.replace(/\/$/, "");
}

/** True when this origin must not be used for LINE/ browser links to your app. */
function isUnsuitableForLineLinks(origin: string): boolean {
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true;
    if (h.endsWith(".local")) return true;
    if (h.includes("ngrok")) return true;
    return false;
  } catch {
    return true;
  }
}

export function getPublicSiteOrigin(): string | null {
  const candidates: string[] = [
    (process.env.INVOICE_PUBLIC_BASE_URL || "").trim(),
    (process.env.NEXT_PUBLIC_BASE_URL || "").trim(),
  ];
  for (const raw of candidates) {
    if (!raw) continue;
    const n = normalizeOrigin(raw);
    if (isUnsuitableForLineLinks(n)) continue;
    return n;
  }
  const vercel = (process.env.VERCEL_URL || "").trim();
  if (vercel) {
    return `https://${vercel.replace(/\/$/, "")}`;
  }
  return null;
}
