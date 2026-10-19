// Where an order came from (Shopify customer journey + UTM tags). Shared by the Worker and the app.

export type Utm = { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };

export type Visit = {
  source: string | null; // Shopify's reading: "facebook", "google", "direct", a domain…
  sourceType: string | null; // Shopify MarketingTactic, e.g. AD, POST, NEWSLETTER
  sourceDescription: string | null;
  referrerUrl: string | null;
  landingPage: string | null;
  utm: Utm | null;
  occurredAt: string | null;
};

export type Attribution = {
  /** "journey" = Shopify's customer journey (best); "web" = landing/referring site of the order; "attributes" = UTM saved by the theme as cart attributes. */
  from: "journey" | "web" | "attributes" | "none";
  firstVisit: Visit | null;
  lastVisit: Visit | null;
  daysToConversion: number | null;
  customerOrderIndex: number | null; // 1 = first order
};

export const CHANNELS = {
  facebook_ads: { label: "Facebook Ads", color: "blue" },
  facebook: { label: "Facebook", color: "blue" },
  instagram_ads: { label: "Instagram Ads", color: "grape" },
  instagram: { label: "Instagram", color: "grape" },
  messenger: { label: "Messenger", color: "indigo" },
  google_ads: { label: "Google Ads", color: "yellow" },
  google: { label: "Google", color: "yellow" },
  tiktok_ads: { label: "TikTok Ads", color: "dark" },
  tiktok: { label: "TikTok", color: "dark" },
  youtube: { label: "YouTube", color: "red" },
  whatsapp: { label: "WhatsApp", color: "green" },
  email: { label: "Email", color: "cyan" },
  sms: { label: "SMS", color: "cyan" },
  search: { label: "Other search", color: "lime" },
  referral: { label: "Other website", color: "teal" },
  direct: { label: "Direct", color: "gray" },
  draft_order: { label: "Manual (draft order)", color: "orange" },
  pos: { label: "Point of sale", color: "orange" },
  app: { label: "Sales channel app", color: "orange" },
  unknown: { label: "Unknown", color: "gray" },
} as const;
export type Channel = keyof typeof CHANNELS;

const emptyUtm = (u: Partial<Utm>): Utm | null => {
  const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);
  const utm = { source: clean(u.source), medium: clean(u.medium), campaign: clean(u.campaign), content: clean(u.content), term: clean(u.term) };
  return Object.values(utm).some(Boolean) ? utm : null;
};

/** UTM tags from a URL or path ("/products/x?utm_source=fb&…"). */
export function utmFromUrl(url: string | null | undefined): Utm | null {
  if (!url) return null;
  try {
    const p = new URL(url, "https://shop.local").searchParams;
    return emptyUtm({ source: p.get("utm_source"), medium: p.get("utm_medium"), campaign: p.get("utm_campaign"), content: p.get("utm_content"), term: p.get("utm_term") });
  } catch {
    return null;
  }
}

/** UTM tags some themes save as cart attributes (utm_source, utm_campaign…). */
export function utmFromAttributes(attrs: { name: string; value: string }[]): Utm | null {
  const get = (k: string) => attrs.find((a) => a.name.toLowerCase().replace(/^_+/, "") === k)?.value ?? null;
  return emptyUtm({ source: get("utm_source"), medium: get("utm_medium"), campaign: get("utm_campaign"), content: get("utm_content"), term: get("utm_term") });
}

const PAID_MEDIUM = /^(cpc|ppc|cpm|cpa|paid|paid[_-]?social|paidsocial|ads?|display|retargeting|sponsored)$/i;
const host = (url: string | null | undefined) => {
  if (!url) return "";
  try {
    return new URL(url, "https://shop.local").hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

function byName(name: string): "facebook" | "instagram" | "messenger" | "google" | "tiktok" | "youtube" | "whatsapp" | "email" | "sms" | "search" | null {
  const n = name.toLowerCase();
  // Meta's {{site_source_name}}: fb, ig, msg, an (audience network)
  if (/^(fb|an)$|facebook|meta/.test(n)) return "facebook";
  if (/^ig$|instagram/.test(n)) return "instagram";
  if (/^msg$|messenger/.test(n)) return "messenger";
  if (/google|gads|adwords/.test(n)) return "google";
  if (/tiktok|^tt$/.test(n)) return "tiktok";
  if (/youtube|^yt$/.test(n)) return "youtube";
  if (/whatsapp|^wa$/.test(n)) return "whatsapp";
  if (/e-?mail|newsletter|klaviyo|mailchimp/.test(n)) return "email";
  if (/^sms$|text/.test(n)) return "sms";
  if (/bing|yahoo|duckduckgo|yandex|baidu/.test(n)) return "search";
  return null;
}

const PAID_CAPABLE = new Set(["facebook", "instagram", "google", "tiktok"]);

/**
 * Our channel for an order. Order of evidence: how the order was created (draft/POS), UTM tags,
 * ad click ids in the landing page (fbclid/gclid/ttclid), Shopify's own source, the referring site.
 */
export function classifyChannel(input: { sourceName: string | null; visit: Visit | null }): Channel {
  const sn = (input.sourceName ?? "").toLowerCase();
  if (sn === "shopify_draft_order") return "draft_order";
  if (sn === "pos") return "pos";
  const v = input.visit;
  const landing = v?.landingPage ?? "";
  const utm = v?.utm;
  const clickId = /[?&]fbclid=/.test(landing) ? "facebook" : /[?&](gclid|gbraid|wbraid)=/.test(landing) ? "google" : /[?&]ttclid=/.test(landing) ? "tiktok" : null;
  const paid = Boolean((utm?.medium && PAID_MEDIUM.test(utm.medium)) || /(^|[_\-\s.])ads?($|[_\-\s.])/i.test(utm?.source ?? "") || v?.sourceType === "AD" || (clickId && clickId !== "facebook"));

  const name = (utm?.source && byName(utm.source)) || clickId || (v?.source && byName(v.source)) || (host(v?.referrerUrl) && byName(host(v?.referrerUrl)));
  if (name) return (paid && PAID_CAPABLE.has(name) ? `${name}_ads` : name) as Channel;
  if (utm?.source || (v?.referrerUrl && host(v.referrerUrl))) return "referral";
  if (v && (v.source === "direct" || (!v.referrerUrl && !utm))) return "direct";
  if (sn && sn !== "web") return "app";
  return "unknown";
}

/** The visit that gets credit for the sale: the last one (last click), else the first. */
export const creditedVisit = (a: Attribution | null) => a?.lastVisit ?? a?.firstVisit ?? null;
