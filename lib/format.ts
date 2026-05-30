export const toNumber = (value: string | number | null | undefined): number => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isNaN(parsed) ? 0 : parsed;
};

export const roundTo2 = (value: number): number => {
  return Math.round((value + Number.EPSILON) * 100) / 100;
};

export const ymdToLocalDate = (ymd: string): Date => {
  const p = String(ymd).slice(0, 10).split("-");
  if (p.length < 3) return new Date(NaN);
  const y = parseInt(p[0] ?? "0", 10);
  const m = parseInt(p[1] ?? "1", 10);
  const d = parseInt(p[2] ?? "1", 10);
  return new Date(y, m - 1, d);
};

export const formatMoney = (value: number): string => {
  return value.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const escapeHtml = (text: string): string => {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
};

export const formatThaiDateShort = (value: string | null | undefined): string => {
  if (!value) return "—";
  return new Date(`${value}T12:00:00`).toLocaleDateString("th-TH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
};

export const toLocalDateString = (date: Date): string => {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
};

export const monthStartFromDateString = (value: string): string => {
  const date = new Date(value);
  return toLocalDateString(new Date(date.getFullYear(), date.getMonth(), 1));
};