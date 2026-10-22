// Smart risk score of an order: one number (0 safe … 100 very risky) built from everything we know
// about the customer and the order. Pure scoring lives here so the Worker and the tests share it.

export type RiskLevel = "low" | "medium" | "high";

export const RISK_LEVELS: Record<RiskLevel, { label: string; color: string; hint: string }> = {
  low: { label: "Safe", color: "teal", hint: "Good signs — book normally" },
  medium: { label: "Check", color: "yellow", hint: "Mixed signs — confirm by phone before booking" },
  high: { label: "Risky", color: "red", hint: "Strong warning signs — call first, consider advance delivery charge" },
};

export const riskLevel = (score: number): RiskLevel => (score >= 60 ? "high" : score >= 35 ? "medium" : "low");

export type RiskGroup = "history" | "courier" | "source" | "district" | "order" | "customer";

export const RISK_GROUPS: Record<RiskGroup, string> = {
  history: "Earlier orders from this number",
  courier: "Courier record (all merchants)",
  source: "Ad / order source",
  district: "Delivery area",
  order: "This order",
  customer: "Customer tag",
};

/** One reason behind the score. Positive points raise the risk, negative points lower it. */
export type RiskFactor = { key: string; group: RiskGroup; label: string; detail?: string | null; points: number };

/** What happened to an earlier order from the same phone number. */
export type PreviousOutcome = "delivered" | "partial" | "returned" | "cancelled" | "cancelled_at_courier" | "rejected" | "in_progress" | "open";

export const PREVIOUS_OUTCOMES: Record<PreviousOutcome, { label: string; color: string }> = {
  delivered: { label: "Received", color: "teal" },
  partial: { label: "Partly received", color: "lime" },
  returned: { label: "Returned", color: "red" },
  cancelled: { label: "Cancelled", color: "dark" },
  cancelled_at_courier: { label: "Cancelled at courier", color: "orange" },
  rejected: { label: "Rejected on call", color: "red" },
  in_progress: { label: "On the way", color: "indigo" },
  open: { label: "Not shipped yet", color: "gray" },
};

export type PreviousOrder = {
  id: number;
  name: string;
  shopCreatedAt: string;
  total: number;
  customerName: string | null;
  address: string;
  sameName: boolean;
  sameAddress: boolean;
  outcome: PreviousOutcome;
  cancelReason: string | null;
  channel: string | null;
  /** Placed shortly before this order (likely the customer re-ordering), so a cancel weighs less. */
  nearby: boolean;
};

/** Return rate of a group of orders (an ad channel, a campaign, a district) against the shop average. */
export type GroupStat = { key: string; finished: number; returned: number; rate: number; shopRate: number };

export type RiskInput = {
  flags: string[];
  previous: PreviousOrder[];
  fraud: { verdict: "good" | "new" | "watch" | "risky" | "unknown"; deliveryRatio: number | null; totalReports: number; reasons: string[] } | null;
  customerFlag: string | null;
  channel: (GroupStat & { label: string }) | null;
  campaign: GroupStat | null;
  district: GroupStat | null;
  /** Starting score before any factor (default 20). */
  base?: number;
};

export type RiskResult = { score: number; level: RiskLevel; headline: string; factors: RiskFactor[] };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Minimum finished orders before a group's return rate counts. */
export const MIN_SAMPLE = { channel: 15, campaign: 10, district: 10 } as const;

/** Points for a group whose return rate differs from the shop average. */
function groupPoints(s: GroupStat, cap: number): number {
  const diff = s.rate - s.shopRate;
  if (diff >= 0.05) return Math.min(cap, Math.round(diff * 60));
  if (diff <= -0.08) return -Math.min(6, Math.round(-diff * 30));
  return 0;
}

export function scoreRisk(input: RiskInput): RiskResult {
  const f: RiskFactor[] = [];
  const add = (x: RiskFactor) => x.points !== 0 && f.push(x);
  const prev = input.previous;

  // ---- Earlier orders from the same number ----
  const delivered = prev.filter((p) => p.outcome === "delivered" || p.outcome === "partial");
  const returned = prev.filter((p) => p.outcome === "returned");
  const courierCancelled = prev.filter((p) => p.outcome === "cancelled_at_courier");
  const cancelled = prev.filter((p) => p.outcome === "cancelled" || p.outcome === "rejected");
  const oldCancels = cancelled.filter((p) => !p.nearby);
  const reorders = cancelled.filter((p) => p.nearby);
  const names = new Set(prev.filter((p) => !p.sameName && p.customerName).map((p) => p.customerName!.trim().toLowerCase()));

  if (!prev.length) add({ key: "first_order", group: "history", label: "First order from this number", detail: "No history with us yet", points: 5 });
  if (delivered.length) {
    add({ key: "received_before", group: "history", label: `Received ${plural(delivered.length, "earlier order")}`, detail: delivered.slice(0, 4).map((p) => p.name).join(", "), points: -Math.min(30, delivered.length * 10) });
  }
  if (returned.length) {
    add({ key: "returned_before", group: "history", label: `Returned ${plural(returned.length, "earlier parcel")}`, detail: returned.slice(0, 4).map((p) => `${p.name}${p.sameName ? "" : ` (as ${p.customerName ?? "another name"})`}`).join(", "), points: Math.min(50, returned.length * 22) });
  }
  if (courierCancelled.length) {
    add({ key: "courier_cancelled_before", group: "history", label: `${plural(courierCancelled.length, "earlier parcel")} cancelled after booking`, detail: courierCancelled.slice(0, 4).map((p) => p.name).join(", "), points: Math.min(30, courierCancelled.length * 12) });
  }
  if (oldCancels.length) {
    add({ key: "cancelled_before", group: "history", label: `${plural(oldCancels.length, "earlier order")} cancelled before shipping`, detail: oldCancels.slice(0, 4).map((p) => `${p.name}${p.outcome === "rejected" ? " (rejected on call)" : p.cancelReason ? ` (${p.cancelReason})` : ""}`).join(", "), points: Math.min(24, oldCancels.length * 8) });
  }
  if (reorders.length) {
    add({ key: "recent_cancel", group: "history", label: `${plural(reorders.length, "order")} from this number cancelled shortly before`, detail: `${reorders.map((p) => p.name).join(", ")} — often a re-order, check it isn't a duplicate`, points: 3 });
  }
  // The same number, but a different name on the orders that went wrong: often the same person.
  const badElsewhere = prev.filter((p) => !p.sameName && ["returned", "cancelled", "rejected", "cancelled_at_courier"].includes(p.outcome) && !p.nearby);
  if (badElsewhere.length) {
    add({ key: "other_name_bad", group: "history", label: "Returned/cancelled under another name", detail: badElsewhere.slice(0, 4).map((p) => `${p.name} as ${p.customerName ?? "unknown"}`).join(", "), points: 12 });
  } else if (names.size >= 1 && prev.length >= 2) {
    add({ key: "many_names", group: "history", label: `Number used under ${plural(names.size + 1, "different name")}`, detail: [...names].slice(0, 4).join(", "), points: names.size >= 2 ? 10 : 4 });
  }

  // ---- Courier fraud check (Steadfast, across all merchants) ----
  const fr = input.fraud;
  if (fr) {
    const ratio = fr.deliveryRatio === null ? "" : `${Math.round(fr.deliveryRatio)}% delivered`;
    if (fr.verdict === "risky") add({ key: "courier_risky", group: "courier", label: "Poor courier record", detail: fr.reasons.join(" · ") || ratio, points: 30 });
    else if (fr.verdict === "watch") add({ key: "courier_watch", group: "courier", label: "Mixed courier record", detail: fr.reasons.join(" · ") || ratio, points: 12 });
    else if (fr.verdict === "good") add({ key: "courier_good", group: "courier", label: "Good courier record", detail: ratio, points: fr.deliveryRatio !== null && fr.deliveryRatio >= 90 ? -15 : -10 });
    else if (fr.verdict === "new") add({ key: "courier_new", group: "courier", label: "No courier history anywhere", detail: "Never received a parcel through Steadfast", points: 4 });
  }

  // ---- Ad / source, campaign and district return rates ----
  if (input.channel) {
    const s = input.channel;
    add({ key: "channel_rate", group: "source", label: `${s.label} orders: ${pct(s.rate)} returned`, detail: `Shop average ${pct(s.shopRate)} · ${s.finished} finished orders`, points: groupPoints(s, 15) });
  }
  if (input.campaign) {
    const s = input.campaign;
    add({ key: "campaign_rate", group: "source", label: `Campaign "${s.key}": ${pct(s.rate)} returned`, detail: `Shop average ${pct(s.shopRate)} · ${s.finished} finished orders`, points: groupPoints(s, 12) });
  }
  if (input.district) {
    const s = input.district;
    add({ key: "district_rate", group: "district", label: `${s.key}: ${pct(s.rate)} returned`, detail: `Shop average ${pct(s.shopRate)} · ${s.finished} finished orders`, points: groupPoints(s, 10) });
  }

  // ---- This order ----
  const flag = (k: string) => input.flags.includes(k);
  if (flag("invalid_phone")) add({ key: "invalid_phone", group: "order", label: "Phone is not a valid Bangladeshi mobile", points: 25 });
  if (flag("test_order")) add({ key: "test_order", group: "order", label: "Looks like a test order", points: 20 });
  if (flag("short_address")) add({ key: "short_address", group: "order", label: "Address looks incomplete", points: 10 });
  if (flag("duplicate_items")) add({ key: "duplicate", group: "order", label: "Same items ordered again recently", detail: "Possible duplicate order", points: 12 });
  else if (flag("duplicate_recent")) add({ key: "duplicate", group: "order", label: "Another order from this number in the last days", points: 6 });
  if (flag("high_value")) add({ key: "high_value", group: "order", label: "High COD value", points: 8 });
  if (flag("large_quantity")) add({ key: "large_quantity", group: "order", label: "Unusually large quantity", points: 6 });

  // ---- Staff tag on the customer ----
  if (input.customerFlag === "blocked") add({ key: "blocked", group: "customer", label: "Customer is blocked", points: 60 });
  else if (input.customerFlag === "risky") add({ key: "tagged_risky", group: "customer", label: "Customer tagged risky by staff", points: 25 });
  else if (input.customerFlag === "vip") add({ key: "vip", group: "customer", label: "VIP customer", points: -20 });

  const raw = (input.base ?? 20) + f.reduce((s, x) => s + x.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const level = riskLevel(score);
  f.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  const worst = f.filter((x) => x.points > 0).sort((a, b) => b.points - a.points)[0];
  const best = f.filter((x) => x.points < 0).sort((a, b) => a.points - b.points)[0];
  const headline = level === "low" ? (best?.label ?? "No warning signs") : (worst?.label ?? "Several small warning signs");
  return { score, level, headline, factors: f };
}

/** Same person? Compares the meaningful words of two names ("Md. Rahim Uddin" ≈ "Rahim"). */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^\p{L}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !["md", "mohammad", "mohammed", "muhammad", "mst", "mrs", "mr", "miss"].includes(w));
  if (!a?.trim() || !b?.trim()) return true; // unknown counts as same: no evidence of a different person
  const x = words(a);
  const y = new Set(words(b));
  if (!x.length || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return x.some((w) => y.has(w));
}

/** Same delivery address, loosely (case, punctuation and spacing ignored). */
export function sameAddress(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const x = n(a);
  const y = n(b);
  if (!x || !y) return true;
  return x === y || x.includes(y) || y.includes(x);
}
