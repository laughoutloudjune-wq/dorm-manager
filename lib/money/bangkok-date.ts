/**
 * Bangkok (Asia/Bangkok, UTC+7, no DST) calendar helpers.
 *
 * Receipts carry a UTC timestamp (`paid_at`). Slicing it as a string buckets by
 * the UTC calendar, so a payment at 00:30 Bangkok on 1 Oct (17:30Z on 30 Sep)
 * lands in September. Always go through these helpers to bucket by day/month.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Bangkok",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * 'YYYY-MM-DD' of an instant in Bangkok. A date-only string is already a
 * calendar date and is returned unchanged. Null/invalid input returns "".
 */
export function toBangkokDate(value: string | Date | null | undefined): string {
  if (value == null || value === "") return "";
  if (typeof value === "string" && DATE_ONLY.test(value)) return value;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 'YYYY-MM' of an instant in Bangkok ("" for null/invalid). */
export function toBangkokMonth(value: string | Date | null | undefined): string {
  return toBangkokDate(value).slice(0, 7);
}

/** ISO instant of 00:00 Bangkok on a 'YYYY-MM-DD' date (for timestamptz range filters). Other values pass through. */
export function bangkokDayStartIso(dateOnly: string): string {
  if (!DATE_ONLY.test(dateOnly)) return dateOnly;
  return new Date(`${dateOnly}T00:00:00+07:00`).toISOString();
}

/** Add whole days to a 'YYYY-MM-DD' calendar date. */
export function addDaysToDate(dateOnly: string, days: number): string {
  const d = new Date(`${dateOnly}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
