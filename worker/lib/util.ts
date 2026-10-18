export const nowIso = () => new Date().toISOString();

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60_000);

/**
 * Normalize a Bangladeshi mobile number to 01XXXXXXXXX (11 digits).
 * Returns null when the input cannot be a valid BD mobile number.
 */
export function normalizeBdPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = input.replace(/[^\d]/g, "");
  if (digits.startsWith("00880")) digits = digits.slice(4);
  else if (digits.startsWith("880")) digits = digits.slice(2);
  else if (digits.startsWith("88") && digits.length === 13) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith("1")) digits = "0" + digits;
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

/** Best-effort cleanup for numbers that fail validation: keep digits so staff can fix them. */
export function cleanPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  return normalizeBdPhone(input) ?? (input.replace(/[^\d+]/g, "") || null);
}

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function gidToId(gid: string | number | null | undefined): string | null {
  if (gid === null || gid === undefined) return null;
  const s = String(gid);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start of "today" in the business time zone, as a UTC ISO string. */
export function startOfDayIso(offset: string, daysAgo = 0, now = new Date()): string {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [h, m] = offset.replace(/^[+-]/, "").split(":").map(Number);
  const offsetMs = sign * ((h || 0) * 60 + (m || 0)) * 60_000;
  const local = new Date(now.getTime() + offsetMs);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - offsetMs - daysAgo * 86_400_000).toISOString();
}

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Neutralise spreadsheet formula injection.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? "'" + s : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** An error that background jobs should not retry. */
export class PermanentError extends Error {
  permanent = true;
}
