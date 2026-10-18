import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";
import dayjs from "dayjs";
import "dayjs/locale/bn";
import preParsePostFormat from "dayjs/plugin/preParsePostFormat";
import "../format"; // registers dayjs relativeTime
import { Ban, Check, CheckCircle2, Clock, Copy, MapPin, Package, PackageCheck, Phone, PhoneMissed, RefreshCw, ShoppingBag, Truck, Undo2, type LucideIcon } from "lucide-react";

/**
 * Customer tracking page (/t/:token, usually on track.arvono.store). Styled after arvono.store:
 * white, black type, Instrument Sans (English) and Anek Bangla (Bangla), pill buttons.
 * Everything is in English and Bangla; the customer's choice is remembered on their phone.
 */

type Tone = "info" | "good" | "warn" | "bad";
type TrackingData = {
  business: { name: string; phone: string | null; website: string | null };
  order: {
    name: string;
    placedAt: string;
    currency: string;
    items: { title: string; variant: string | null; quantity: number; price: number }[];
    subtotal: number;
    shipping: number;
    discount: number;
    total: number;
    codDue: number;
    shipsWith: string[];
  };
  customer: { name: string | null; phone: string | null; address: string | null; city: string | null };
  courier: { name: string; trackingCode: string | null; consignmentId: string | null } | null;
  status: { key: string; title: string; tone: Tone };
  steps: { key: string; label: string; done: boolean; at: string | null }[];
  timeline: { at: string; kind: string; title: string; detail?: string | null; tone: Tone }[];
  updatedAt: string;
};

type Lang = "en" | "bn";
dayjs.extend(preParsePostFormat); // Bangla digits in dates (the bn locale's postformat)

const LOGO = "https://arvono.store/cdn/shop/files/arvono-shopify-logo-black-transparent.png";
const FONTS = "https://fonts.googleapis.com/css2?family=Anek+Bangla:wght@400;500;600;700&family=Instrument+Sans:wght@400;500;600;700&display=swap";
const LANG_KEY = "arvono.track.lang";

const UI = {
  status: { en: "Order status", bn: "অর্ডারের অবস্থা" },
  updates: { en: "Updates", bn: "আপডেট" },
  yourOrder: { en: "Your order", bn: "আপনার অর্ডার" },
  subtotal: { en: "Subtotal", bn: "সাবটোটাল" },
  discount: { en: "Discount", bn: "ছাড়" },
  delivery: { en: "Delivery", bn: "ডেলিভারি চার্জ" },
  total: { en: "Total", bn: "মোট" },
  cod: { en: "Cash on delivery", bn: "ক্যাশ অন ডেলিভারি" },
  codHint: { en: "Please keep this amount ready for the rider", bn: "রাইডারের জন্য এই টাকা প্রস্তুত রাখুন" },
  address: { en: "Delivery address", bn: "ডেলিভারি ঠিকানা" },
  courier: { en: "Courier partner", bn: "কুরিয়ার পার্টনার" },
  trackingCode: { en: "Copy tracking code", bn: "ট্র্যাকিং কোড কপি করুন" },
  copied: { en: "Copied", bn: "কপি হয়েছে" },
  callUs: { en: "Call us", bn: "আমাদের কল করুন" },
  shop: { en: "Continue shopping", bn: "শপিং চালিয়ে যান" },
  together: { en: "These orders travel together in one parcel", bn: "এই অর্ডারগুলো একসাথে একটি পার্সেলে যাচ্ছে" },
  placedOn: { en: "Placed", bn: "অর্ডার" },
  refreshed: { en: "Updated", bn: "আপডেট" },
  help: { en: "Questions about your order?", bn: "অর্ডার নিয়ে কোনো প্রশ্ন?" },
  invalid: { en: "This tracking link is not valid. Please check the link or contact us.", bn: "এই ট্র্যাকিং লিংকটি সঠিক নয়। লিংকটি যাচাই করুন বা আমাদের সাথে যোগাযোগ করুন।" },
  failed: { en: "Couldn't load tracking right now. Please try again in a moment.", bn: "এখন ট্র্যাকিং লোড করা যাচ্ছে না। কিছুক্ষণ পর আবার চেষ্টা করুন।" },
} satisfies Record<string, Record<Lang, string>>;

const STEPS: Record<string, Record<Lang, string>> = {
  placed: { en: "Placed", bn: "অর্ডার" },
  confirmed: { en: "Confirmed", bn: "নিশ্চিত" },
  packed: { en: "Packed", bn: "প্যাক" },
  shipped: { en: "On the way", bn: "পথে" },
  delivered: { en: "Delivered", bn: "পৌঁছেছে" },
};

/** Bangla for every title the server writes; Steadfast's own update texts stay as they are. */
const TITLES_BN: Record<string, string> = {
  "Order placed": "অর্ডার করা হয়েছে",
  "We called to confirm but couldn't reach you": "নিশ্চিত করতে কল করেছিলাম, কিন্তু আপনাকে পাওয়া যায়নি",
  "We'll call you again to confirm": "নিশ্চিত করতে আমরা আবার কল করব",
  "Order confirmed on the phone": "ফোনে অর্ডার নিশ্চিত হয়েছে",
  "Order cancelled on the confirmation call": "নিশ্চিতকরণ কলে অর্ডার বাতিল হয়েছে",
  "Order confirmed": "অর্ডার নিশ্চিত হয়েছে",
  "Sent to Steadfast Courier": "Steadfast কুরিয়ারে পাঠানো হয়েছে",
  "Picked up by Steadfast — on the way": "Steadfast পার্সেলটি নিয়েছে — পথে আছে",
  "Product returned — delivery charge paid": "পণ্য ফেরত — ডেলিভারি চার্জ পরিশোধিত",
  "Partially delivered": "আংশিক ডেলিভারি হয়েছে",
  Delivered: "ডেলিভারি সম্পন্ন",
  "Returned items received back by us": "ফেরত পণ্য আমরা বুঝে পেয়েছি",
  "Delivery failed — parcel returned": "ডেলিভারি হয়নি — পার্সেল ফেরত এসেছে",
  "Packed and ready for courier pickup": "প্যাক করা হয়েছে, কুরিয়ার পিকআপের জন্য প্রস্তুত",
  "Delivery on hold": "ডেলিভারি আপাতত স্থগিত",
  "Delivery cancelled": "ডেলিভারি বাতিল হয়েছে",
  "Order cancelled": "অর্ডার বাতিল হয়েছে",
  "Parcel returned": "পার্সেল ফেরত এসেছে",
  "On the way with Steadfast": "Steadfast-এর মাধ্যমে পথে আছে",
  "Packed — waiting for courier pickup": "প্যাক সম্পন্ন — কুরিয়ার পিকআপের অপেক্ষায়",
  "Sent to courier — being packed": "কুরিয়ারে বুক হয়েছে — প্যাক করা হচ্ছে",
  "Confirmed — preparing your parcel": "নিশ্চিত — আপনার পার্সেল প্রস্তুত হচ্ছে",
  "Waiting for confirmation — please pick up our call": "নিশ্চিতকরণের অপেক্ষায় — অনুগ্রহ করে আমাদের কল ধরুন",
  "Order received — we'll call you to confirm": "অর্ডার পেয়েছি — নিশ্চিত করতে আমরা কল করব",
};

const NEXT: Record<string, Record<Lang, string>> = {
  placed: { en: "We'll call you shortly to confirm your order.", bn: "অর্ডার নিশ্চিত করতে শীঘ্রই আমরা আপনাকে কল করব।" },
  awaiting_call: { en: "We couldn't reach you. Please keep your phone close — we'll call again.", bn: "আপনাকে ফোনে পাওয়া যায়নি। ফোন কাছে রাখুন — আমরা আবার কল করব।" },
  confirmed: { en: "Your order is confirmed and being prepared.", bn: "আপনার অর্ডার নিশ্চিত হয়েছে এবং প্রস্তুত করা হচ্ছে।" },
  booked: { en: "Your parcel is booked with Steadfast and being packed.", bn: "আপনার পার্সেল Steadfast-এ বুক হয়েছে এবং প্যাক করা হচ্ছে।" },
  packed: { en: "Packed and waiting for the courier to pick it up.", bn: "প্যাক সম্পন্ন, কুরিয়ার এসে নিয়ে যাওয়ার অপেক্ষায়।" },
  shipped: { en: "Your parcel is on the way. The rider will call before delivery.", bn: "আপনার পার্সেল পথে আছে। ডেলিভারির আগে রাইডার আপনাকে কল করবেন।" },
  on_hold: { en: "Delivery is paused for now. We'll be in touch.", bn: "ডেলিভারি আপাতত স্থগিত আছে। আমরা যোগাযোগ করব।" },
  delivered: { en: "Thank you for shopping with us!", bn: "আমাদের সাথে কেনাকাটার জন্য ধন্যবাদ!" },
  returned: { en: "This parcel is coming back to us.", bn: "এই পার্সেলটি আমাদের কাছে ফেরত আসছে।" },
  cancelled: { en: "This order won't be delivered.", bn: "এই অর্ডারটি ডেলিভারি হবে না।" },
};

const STEP_ICON: Record<string, LucideIcon> = { placed: ShoppingBag, confirmed: Check, packed: PackageCheck, shipped: Truck, delivered: CheckCircle2 };

function eventIcon(kind: string): LucideIcon {
  if (kind === "placed") return ShoppingBag;
  if (kind === "call_confirmed") return Check;
  if (kind === "call_no_answer") return PhoneMissed;
  if (kind === "call_call_again") return Phone;
  if (kind === "call_rejected" || kind === "cancelled" || kind === "courier_cancelled") return Ban;
  if (kind === "booked") return Package;
  if (kind === "packed") return PackageCheck;
  if (kind === "delivered") return CheckCircle2;
  if (kind === "returned") return Undo2;
  if (kind === "on_hold") return Clock;
  return Truck;
}

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "bn") return saved;
  } catch {
    // storage blocked (private mode): fall through
  }
  return typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("bn") ? "bn" : "en";
}

/** Loads the store's fonts for this page only (the dashboard doesn't need them). */
function useBrandFonts() {
  useEffect(() => {
    if (document.querySelector(`link[href="${FONTS}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = FONTS;
    document.head.appendChild(link);
  }, []);
}

export default function Track() {
  const { token = "" } = useParams();
  const [data, setData] = useState<TrackingData | null>(null);
  const [error, setError] = useState<"invalid" | "failed" | null>(null);
  const [loading, setLoading] = useState(false);
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [copied, setCopied] = useState(false);
  const [logoOk, setLogoOk] = useState(true);
  useBrandFonts();

  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      // not remembered; still switches for this visit
    }
  };

  const t = (key: keyof typeof UI) => UI[key][lang];
  const tr = (title: string) => (lang === "bn" ? TITLES_BN[title] ?? title : title);
  const fmt = useMemo(() => {
    const nf = new Intl.NumberFormat(lang === "bn" ? "bn-BD" : "en-IN", { maximumFractionDigits: 0 });
    return {
      money: (n: number) => `৳${nf.format(n)}`,
      num: (n: number) => nf.format(n),
      date: (s: string) => dayjs(s).locale(lang).format("D MMM, h:mm A"),
      day: (s: string) => dayjs(s).locale(lang).format("D MMM"),
      long: (s: string) => dayjs(s).locale(lang).format("D MMMM YYYY"),
      ago: (s: string) => dayjs(s).locale(lang).fromNow(),
    };
  }, [lang]);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/public/track/${encodeURIComponent(token)}`);
      if (r.status === 404) setError("invalid");
      else if (!r.ok) throw new Error();
      else {
        setData(await r.json());
        setError(null);
      }
    } catch {
      setError((e) => e ?? "failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (data) document.title = `${data.order.name} · ${tr(data.status.title)} — ${data.business.name}`;
    document.documentElement.lang = lang;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, lang]);

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const brandName = data?.business.name ?? "ARVONO";
  const website = data?.business.website ?? "https://arvono.store";
  const header = (
    <header className="av-header">
      <div className="av-wrap av-header-row">
        <a href={website} className="av-logo" aria-label={brandName}>
          {logoOk ? <img src={LOGO} alt={brandName} onError={() => setLogoOk(false)} /> : <span className="av-wordmark">{brandName}</span>}
        </a>
        <div className="av-lang" role="group" aria-label="Language">
          <button type="button" aria-pressed={lang === "en"} onClick={() => setLang("en")}>EN</button>
          <button type="button" aria-pressed={lang === "bn"} onClick={() => setLang("bn")}>বাংলা</button>
        </div>
      </div>
    </header>
  );

  if (!data) {
    return (
      <div className="av">
        {header}
        <main className="av-wrap av-empty">{error ? <p>{t(error)}</p> : <div className="av-spinner" aria-label="Loading" />}</main>
      </div>
    );
  }

  const { status, order } = data;
  const stopped = status.key === "cancelled" || status.key === "returned";
  const doneCount = data.steps.filter((s) => s.done).length;
  const current = Math.max(0, doneCount - 1);

  return (
    <div className="av">
      {header}
      <main className="av-wrap av-main">
        {/* Status */}
        <section className="av-hero">
          <div className="av-eyebrow">
            <span>{t("status")}</span>
            <span className="av-dot-sep" />
            <span>{order.name}</span>
          </div>
          <h1 className="av-title">
            <span className="av-tone" data-tone={status.tone} />
            {tr(status.title)}
          </h1>
          <p className="av-next">{NEXT[status.key]?.[lang] ?? ""}</p>

          {!stopped && (
            <ol className="av-steps" style={{ ["--av-progress" as string]: `${(current / (data.steps.length - 1)) * 100}%` }}>
              {data.steps.map((s, i) => {
                const Icon = STEP_ICON[s.key] ?? Check;
                return (
                  <li key={s.key} data-done={s.done} data-current={i === current && status.key !== "delivered"}>
                    <span className="av-step-dot"><Icon size={14} strokeWidth={2.25} /></span>
                    <span className="av-step-label">{STEPS[s.key]?.[lang] ?? s.label}</span>
                    <span className="av-step-at">{s.at && s.done ? fmt.day(s.at) : " "}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {order.codDue > 0 && !stopped && (
          <section className="av-cod">
            <div>
              <div className="av-label">{t("cod")}</div>
              <div className="av-muted">{t("codHint")}</div>
            </div>
            <div className="av-cod-amount">{fmt.money(order.codDue)}</div>
          </section>
        )}
        {order.shipsWith.length > 0 && (
          <p className="av-note">
            {t("together")}: <b>{[order.name, ...order.shipsWith].join(" + ")}</b>
          </p>
        )}

        {/* Timeline */}
        <section className="av-card">
          <div className="av-card-head">
            <h2>{t("updates")}</h2>
            <button type="button" className="av-refresh" onClick={() => void load()} aria-label="Refresh">
              <RefreshCw size={13} className={loading ? "spin" : undefined} /> {t("refreshed")} {fmt.ago(data.updatedAt)}
            </button>
          </div>
          <ol className="av-timeline">
            {data.timeline.map((e, i) => {
              const Icon = eventIcon(e.kind);
              return (
                <li key={`${e.kind}-${e.at}-${i}`} data-latest={i === 0} data-tone={e.tone}>
                  <span className="av-tl-dot"><Icon size={13} strokeWidth={2.25} /></span>
                  <div>
                    <div className="av-tl-title">{tr(e.title)}</div>
                    {e.detail && <div className="av-muted">{e.detail}</div>}
                    <div className="av-tl-time">{fmt.date(e.at)}</div>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>

        {/* Courier */}
        {data.courier && (
          <section className="av-card av-courier">
            <span className="av-icon-box"><Truck size={18} /></span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="av-label">{data.courier.name}</div>
              <div className="av-muted">{t("courier")}</div>
            </div>
            {data.courier.trackingCode && (
              <button type="button" className="av-chip" onClick={() => copy(data.courier!.trackingCode!)} title={t("trackingCode")}>
                <span className="av-mono">{data.courier.trackingCode}</span>
                {copied ? <Check size={14} aria-label={t("copied")} /> : <Copy size={14} aria-label={t("trackingCode")} />}
              </button>
            )}
          </section>
        )}

        {/* Order */}
        <section className="av-card">
          <div className="av-card-head">
            <h2>{t("yourOrder")}</h2>
            <span className="av-muted">{t("placedOn")} · {fmt.long(order.placedAt)}</span>
          </div>
          <ul className="av-items">
            {order.items.map((it, i) => (
              <li key={i}>
                <span className="av-qty">{fmt.num(it.quantity)}×</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="av-item-title">{it.title}</div>
                  {it.variant && <div className="av-muted">{it.variant}</div>}
                </div>
                <span className="av-num">{fmt.money(it.price * it.quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="av-totals">
            <div><dt>{t("subtotal")}</dt><dd>{fmt.money(order.subtotal)}</dd></div>
            {order.discount > 0 && <div><dt>{t("discount")}</dt><dd>−{fmt.money(order.discount)}</dd></div>}
            <div><dt>{t("delivery")}</dt><dd>{fmt.money(order.shipping)}</dd></div>
            <div className="av-grand"><dt>{t("total")}</dt><dd>{fmt.money(order.total)}</dd></div>
          </dl>
          {(data.customer.address || data.customer.name) && (
            <div className="av-address">
              <MapPin size={16} />
              <div>
                <div className="av-label">{t("address")}</div>
                <div>{data.customer.name}</div>
                <div className="av-muted">{[data.customer.address, data.customer.city].filter(Boolean).join(", ")}</div>
                {data.customer.phone && <div className="av-muted av-mono">{data.customer.phone}</div>}
              </div>
            </div>
          )}
        </section>

        {/* Help */}
        <section className="av-help">
          <p>{t("help")}</p>
          <div className="av-actions">
            {data.business.phone && (
              <a className="av-btn av-btn-primary" href={`tel:${data.business.phone}`}><Phone size={16} /> {t("callUs")}</a>
            )}
            <a className="av-btn av-btn-secondary" href={website}>{t("shop")}</a>
          </div>
        </section>
      </main>
      <footer className="av-footer">
        <div className="av-wrap">
          © {new Date().getFullYear()} {brandName} · <a href={website}>{website.replace(/^https?:\/\//, "")}</a>
        </div>
      </footer>
    </div>
  );
}
