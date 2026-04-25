/** Calendar date in Asia/Bangkok (YYYY-MM-DD) — used for move-out notice vs requested date. */

export function bangkokYmd(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function parseBangkokYmdToUtcNoon(ymd: string): number {
  return new Date(`${ymd}T12:00:00+07:00`).getTime();
}

/** Whole calendar days from notice date (inclusive) to move-out date (inclusive step from notice). */
export function calendarDaysFromNoticeToMoveOut(noticeYmd: string, moveOutYmd: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(noticeYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(moveOutYmd)) {
    return NaN;
  }
  return Math.round(
    (parseBangkokYmdToUtcNoon(moveOutYmd) - parseBangkokYmdToUtcNoon(noticeYmd)) / (24 * 60 * 60 * 1000)
  );
}

export function addDaysBangkok(ymd: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return ymd;
  const ms = parseBangkokYmdToUtcNoon(ymd) + days * 24 * 60 * 60 * 1000;
  return bangkokYmd(new Date(ms));
}

/** At least 30 full calendar days between the notice date and the intended move-out date. */
export function meets30DayMoveOutNotice(noticeYmd: string, moveOutYmd: string): boolean {
  return calendarDaysFromNoticeToMoveOut(noticeYmd, moveOutYmd) >= 30;
}
