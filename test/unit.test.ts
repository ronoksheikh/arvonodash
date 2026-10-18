import { describe, expect, it } from "vitest";
import { normalizeBdPhone, startOfDayIso, csvEscape, gidToId } from "../worker/lib/util";
import { hashPassword, verifyPassword, hmacSha256Base64, timingSafeEqual } from "../worker/lib/crypto";
import { stageForStatus, isPickedUpStatus, isFinalStatus } from "../worker/services/steadfast";
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
    expect(stageForStatus("delivered_approval_pending", true)).toBe("delivered");
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
