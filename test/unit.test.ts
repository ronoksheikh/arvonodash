import { describe, expect, it } from "vitest";
import { normalizeBdPhone, startOfDayIso, csvEscape, gidToId } from "../worker/lib/util";
import { hashPassword, verifyPassword, hmacSha256Base64, hmacSha256Hex, timingSafeEqual } from "../worker/lib/crypto";
import { stageForStatus, isPickedUpStatus, isFinalStatus, normalizeFraudScore, parseSteadfastTime, pollVerdict } from "../worker/services/steadfast";
import { shipByDate } from "../worker/services/pickup";
import { renderTemplate } from "../worker/services/sms";
import { smsSegments } from "../shared/constants";
import { classifyChannel, utmFromAttributes, utmFromUrl } from "../shared/attribution";
import { judgeFraud } from "../worker/services/fraud";
import { DEFAULT_SETTINGS, normalizeBaseUrl } from "../worker/services/settings";
import { partialOutcome } from "../shared/delivery";
import { normalizeRestOrder } from "../worker/services/shopify";
import { buildAddress } from "../worker/services/orders";
import { validateBooking } from "../worker/services/courier";
import { collectConsignmentIds } from "../worker/services/sync";

describe("normalizeBdPhone", () => {
  it.each([
    ["01712345678", "01712345678"],
    ["+8801712345678", "01712345678"],
    ["8801712345678", "01712345678"],
    ["008801712345678", "01712345678"],
    ["017-1234 5678", "01712345678"],
    ["1712345678", "01712345678"],
    ["01212345678", null],
    ["0171234567", null],
    ["", null],
    [null, null],
  ])("%s -> %s", (input, expected) => expect(normalizeBdPhone(input)).toBe(expected));
});

describe("steadfast status mapping", () => {
  it("maps statuses to stages", () => {
    expect(stageForStatus("in_review", false)).toBe("booked");
    expect(stageForStatus("pending", true)).toBe("in_transit");
    expect(stageForStatus("hold", true)).toBe("on_hold");
    expect(stageForStatus("delivered_approval_pending", true)).toBe("awaiting_confirmation");
    expect(stageForStatus("partial_delivered", true)).toBe("partial_delivered");
    expect(stageForStatus("cancelled", true)).toBe("returned");
    expect(stageForStatus("cancelled", false)).toBe("cancelled");
    expect(stageForStatus("unknown", true)).toBe("issue");
  });
  it("detects pickup and final statuses", () => {
    expect(isPickedUpStatus("in_review")).toBe(false);
    expect(isPickedUpStatus("pending")).toBe(true);
    expect(isPickedUpStatus("cancelled")).toBe(false);
    expect(isPickedUpStatus("delivered")).toBe(true);
    expect(isFinalStatus("delivered")).toBe(true);
    expect(isFinalStatus("delivered_approval_pending")).toBe(false);
  });
});

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("computes Shopify-style HMAC", async () => {
    // Known vector: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
    expect(await hmacSha256Base64("key", "The quick brown fox jumps over the lazy dog")).toBe("97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=");
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("helpers", () => {
  it("computes Dhaka start of day", () => {
    // 2026-10-18 02:00 UTC = 08:00 in Dhaka -> start of day = 2026-10-17T18:00Z
    expect(startOfDayIso("+06:00", 0, new Date("2026-10-18T02:00:00Z"))).toBe("2026-10-17T18:00:00.000Z");
    // 2026-10-17 20:00 UTC = 02:00 next day in Dhaka
    expect(startOfDayIso("+06:00", 0, new Date("2026-10-17T20:00:00Z"))).toBe("2026-10-17T18:00:00.000Z");
  });
  it("escapes CSV and blocks formula injection", () => {
    expect(csvEscape('a,"b"')).toBe('"a,""b"""');
    expect(csvEscape("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvEscape("-500")).toBe("-500");
  });
  it("extracts ids from gids", () => expect(gidToId("gid://shopify/Order/123")).toBe("123"));
  it("builds addresses without duplicates", () => {
    expect(buildAddress({ address1: "House 4, Road 2", address2: null, city: "Dhaka", zip: "1209" })).toBe("House 4, Road 2, Dhaka, 1209");
    expect(buildAddress({ address1: "Mirpur 10", address2: "Dhaka", city: "dhaka", zip: null })).toBe("Mirpur 10, Dhaka");
  });
  it("finds consignment ids in nested payment payloads", () => {
    const ids = collectConsignmentIds({ data: { consignments: [{ consignment_id: 11 }, { consignment_id: "12" }] } });
    expect([...ids]).toEqual(["11", "12"]);
  });
});

describe("booking validation", () => {
  const ok = { recipientName: "Rahim", recipientPhone: "01712345678", recipientAddress: "House 1, Dhaka", codAmount: 1200, deliveryType: 0 as const };
  it("accepts valid booking", () => expect(validateBooking(ok)).toEqual([]));
  it("rejects bad phone and long address", () => {
    const errs = validateBooking({ ...ok, recipientPhone: "123", recipientAddress: "x".repeat(251), codAmount: -1 });
    expect(errs).toHaveLength(3);
  });
});

describe("normalizeRestOrder", () => {
  it("maps webhook payload", () => {
    const o = normalizeRestOrder({
      id: 5001, name: "#1001", order_number: 1001, created_at: "2026-10-18T10:00:00+06:00", updated_at: "2026-10-18T10:00:00+06:00",
      financial_status: "pending", fulfillment_status: null, total_price: "1250.00", subtotal_price: "1130.00", total_outstanding: "1250.00",
      total_discounts: "0.00", currency: "BDT", tags: "vip, repeat", payment_gateway_names: ["Cash on Delivery (COD)"],
      shipping_lines: [{ title: "Inside Dhaka", price: "120.00" }],
      shipping_address: { name: "Karim Uddin", address1: "House 12, Road 5", city: "Dhaka", phone: "+880 1812-345678" },
      line_items: [{ id: 9, title: "T-shirt", variant_title: "L", quantity: 2, price: "565.00", variant_id: 77 }],
    });
    expect(o.shopifyId).toBe("5001");
    expect(o.rawPhone).toBe("+880 1812-345678");
    expect(o.outstanding).toBe(1250);
    expect(o.shippingTotal).toBe(120);
    expect(o.shopifyTags).toEqual(["vip", "repeat"]);
    expect(o.shopifyFulfillmentStatus).toBe("unfulfilled");
    expect(o.lineItems[0]).toMatchObject({ id: "9", quantity: 2, price: 565, variantId: "77" });
  });
});

describe("Steadfast statuses", () => {
  it("treats the rider's word as unconfirmed until Steadfast confirms", () => {
    for (const s of ["delivered_approval_pending", "partial_delivered_approval_pending", "cancelled_approval_pending", "unknown_approval_pending"]) {
      expect(stageForStatus(s, true)).toBe("awaiting_confirmation");
    }
    expect(stageForStatus("delivered", true)).toBe("delivered");
    expect(stageForStatus("exceptional", true)).toBe("issue");
  });

  it("reads zone-less Steadfast times as Bangladesh time", () => {
    expect(parseSteadfastTime("2025-03-02 12:45:30")).toBe("2025-03-02T06:45:30.000Z");
    expect(parseSteadfastTime("2025-03-02T12:45:30Z")).toBe("2025-03-02T12:45:30.000Z");
    expect(parseSteadfastTime("not a date")).toBeNull();
    expect(parseSteadfastTime(undefined)).toBeNull();
  });
});

describe("partial delivery outcome", () => {
  const items = [{ price: 450, quantity: 2 }, { price: 230, quantity: 1 }];
  it("only the delivery charge collected → product returned", () => expect(partialOutcome(120, items)).toBe("charge_only"));
  it("enough for an item → some items kept", () => expect(partialOutcome(570, items)).toBe("some_items"));
});

describe("fraud check", () => {
  it("normalizes the documented score shape (with or without a data wrapper)", () => {
    const doc = { phone: "01712345678", delivery_ratio: 92, cancellation_ratio: 7, volume_band: "high", total_reports: 1, fraud_categories: ["fake order"], score: null, level: null, doubtful_reports: false };
    expect(normalizeFraudScore(doc)).toMatchObject({ deliveryRatio: 92, cancellationRatio: 7, volumeBand: "high", totalReports: 1, categories: ["fake order"] });
    expect(normalizeFraudScore({ data: doc }).deliveryRatio).toBe(92);
  });

  it("derives ratios from older count-based responses and keeps null when nothing finished", () => {
    expect(normalizeFraudScore({ total_parcels: 10, total_delivered: 8, total_cancelled: 2, total_fraud_reports: [] })).toMatchObject({ deliveryRatio: 80, cancellationRatio: 20, totalReports: 0 });
    expect(normalizeFraudScore({ delivery_ratio: null, volume_band: "none", total_reports: 0 }).deliveryRatio).toBeNull();
  });

  const s = { ...DEFAULT_SETTINGS };
  it.each([
    [{ deliveryRatio: 95, totalReports: 0, doubtfulReports: false, volumeBand: "high" }, "good"],
    [{ deliveryRatio: 78, totalReports: 0, doubtfulReports: false, volumeBand: "medium" }, "watch"],
    [{ deliveryRatio: 60, totalReports: 0, doubtfulReports: false, volumeBand: "medium" }, "risky"],
    [{ deliveryRatio: 95, totalReports: 2, doubtfulReports: false, volumeBand: "high" }, "risky"],
    [{ deliveryRatio: 95, totalReports: 2, doubtfulReports: true, volumeBand: "high" }, "watch"],
    [{ deliveryRatio: null, totalReports: 0, doubtfulReports: false, volumeBand: "none" }, "new"],
  ])("judges %j as %s", (score, verdict) => expect(judgeFraud(score, s).verdict).toBe(verdict));

  it("can treat customers with no history as risky", () => {
    expect(judgeFraud({ deliveryRatio: null, totalReports: 0, doubtfulReports: false, volumeBand: "none" }, { ...s, fraudHoldNewCustomers: true }).verdict).toBe("risky");
  });
});

describe("hmacSha256Hex", () => {
  it("produces the standard hex HMAC (Steadfast X-Signature)", async () => {
    // RFC 4231-style known vector
    expect(await hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")).toBe("f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

describe("poll verdict (deleted / regressing parcels)", () => {
  const base = { isFinal: false, pickedUpAt: null };
  it("'unknown' for a cancelled parcel that was never picked up means it was deleted in Steadfast", () =>
    expect(pollVerdict({ ...base, status: "cancelled", isFinal: true }, "unknown")).toBe("deleted"));
  it("'not found' before pickup means deleted", () => expect(pollVerdict({ ...base, status: "in_review" }, null)).toBe("deleted"));
  it("a booking still in flight is never treated as deleted", () => expect(pollVerdict({ ...base, status: "creating" }, null)).toBe("ignore"));
  it("'unknown' after pickup is a real delivery problem", () =>
    expect(pollVerdict({ ...base, status: "pending", pickedUpAt: "2026-10-18T05:00:00Z" }, "unknown")).toBe("apply"));
  it("a finished parcel never goes back to an open status", () =>
    expect(pollVerdict({ status: "delivered", isFinal: true, pickedUpAt: "2026-10-18T05:00:00Z" }, "pending")).toBe("ignore"));
  it("an already-deleted parcel stays deleted", () => expect(pollVerdict({ status: "deleted", isFinal: true, pickedUpAt: null }, "unknown")).toBe("ignore"));
  it("normal progress applies", () => expect(pollVerdict({ ...base, status: "in_review" }, "pending")).toBe("apply"));
  it("an old record stuck at 'unknown' before pickup is recognised as deleted", () => expect(pollVerdict({ ...base, status: "unknown" }, "unknown")).toBe("deleted"));
  it("a rider's 'unknown' report is not mistaken for a deletion", () => expect(pollVerdict({ ...base, status: "unknown_approval_pending" }, "unknown")).toBe("apply"));
  it("deleted maps to a cancelled, final stage", () => {
    expect(stageForStatus("deleted", false)).toBe("cancelled");
    expect(isFinalStatus("deleted")).toBe(true);
    expect(isPickedUpStatus("deleted")).toBe(false);
  });
});

describe("ship-by date (same-day cut-off)", () => {
  // 16:00 Dhaka = 10:00 UTC
  it("ready before the cut-off ships today", () => expect(shipByDate("2026-10-18T09:59:00Z", "16:00", "+06:00")).toBe("2026-10-18"));
  it("ready after the cut-off ships tomorrow", () => expect(shipByDate("2026-10-18T10:01:00Z", "16:00", "+06:00")).toBe("2026-10-19"));
  it("uses the Dhaka date, not UTC", () => expect(shipByDate("2026-10-18T19:00:00Z", "16:00", "+06:00")).toBe("2026-10-19"));
  it("rolls over month ends", () => expect(shipByDate("2026-10-31T12:00:00Z", "16:00", "+06:00")).toBe("2026-11-01"));
});

describe("SMS", () => {
  it("fills placeholders and keeps unknown ones visible", () =>
    expect(renderTemplate("Hi {name}, {order} {oops}", { name: "Rahim", order: "#1001" })).toBe("Hi Rahim, #1001 {oops}"));
  it("counts GSM and Unicode (Bangla) segments", () => {
    expect(smsSegments("a".repeat(160)).segments).toBe(1);
    expect(smsSegments("a".repeat(161)).segments).toBe(2);
    expect(smsSegments("আ".repeat(70))).toMatchObject({ unicode: true, segments: 1 });
    expect(smsSegments("আ".repeat(71)).segments).toBe(2);
  });
});

describe("tracking domain", () => {
  it.each([
    ["track.arvono.store", "https://track.arvono.store"],
    ["https://track.arvono.store/", "https://track.arvono.store"],
    ["", ""],
  ])("normalizes %s", (input, out) => expect(normalizeBaseUrl(input)).toBe(out));
  it.each(["http://track.arvono.store", "https://track.arvono.store/?x=1", "not a url at all"])("rejects %s", (input) => expect(normalizeBaseUrl(input)).toBeNull());
});

describe("order source", () => {
  const visit = (v: Partial<import("../shared/attribution").Visit>) => ({ source: null, sourceType: null, sourceDescription: null, referrerUrl: null, landingPage: null, utm: null, occurredAt: null, ...v });
  it("reads UTM tags from a landing path", () => expect(utmFromUrl("/p/x?utm_source=fb&utm_campaign=eid")).toMatchObject({ source: "fb", campaign: "eid", medium: null }));
  it.each([
    [{ utm: { source: "fb", medium: "paid", campaign: "x", content: null, term: null } }, "facebook_ads"],
    [{ utm: { source: "facebook", medium: "social", campaign: null, content: null, term: null } }, "facebook"],
    [{ utm: { source: "ig", medium: "cpc", campaign: null, content: null, term: null } }, "instagram_ads"],
    [{ landingPage: "/?gclid=123" }, "google_ads"],
    [{ landingPage: "/?fbclid=1", referrerUrl: "https://l.facebook.com/" }, "facebook"],
    [{ source: "google", referrerUrl: "https://www.google.com/" }, "google"],
    [{ referrerUrl: "https://someblog.com/post" }, "referral"],
    [{ source: "direct" }, "direct"],
    [{ utm: { source: "leads_list", medium: null, campaign: null, content: null, term: null } }, "referral"],
  ])("classifies %j as %s", (v, expected) => expect(classifyChannel({ sourceName: "web", visit: visit(v as never) })).toBe(expected));
  it("staff-made and POS orders", () => {
    expect(classifyChannel({ sourceName: "shopify_draft_order", visit: null })).toBe("draft_order");
    expect(classifyChannel({ sourceName: "pos", visit: null })).toBe("pos");
    expect(classifyChannel({ sourceName: "web", visit: null })).toBe("unknown");
  });
  it("reads UTM cart attributes", () => expect(utmFromAttributes([{ name: "_utm_source", value: "tiktok" }])?.source).toBe("tiktok"));
});
