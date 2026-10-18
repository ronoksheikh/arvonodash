import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { CopyButton, Group, Loader, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import {
  Ban, Check, CheckCircle2, Clock, Copy, MapPin, Package, PackageCheck, Phone, PhoneMissed, RefreshCw, ShoppingBag, Truck, Undo2, type LucideIcon,
} from "lucide-react";
import { ago, dateTime, money } from "../format";

type Tone = "info" | "good" | "warn" | "bad";
type TrackingData = {
  business: { name: string; phone: string | null };
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

const TONE_COLOR: Record<Tone, string> = { info: "#575bf0", good: "#12a150", warn: "#e8890c", bad: "#d92d2d" };

const STEP_ICON: Record<string, LucideIcon> = { placed: ShoppingBag, confirmed: Check, packed: PackageCheck, shipped: Truck, delivered: CheckCircle2 };

const STATUS_ICON: Record<string, LucideIcon> = {
  placed: ShoppingBag,
  awaiting_call: Phone,
  confirmed: Check,
  booked: Package,
  packed: PackageCheck,
  shipped: Truck,
  on_hold: Clock,
  delivered: CheckCircle2,
  returned: Undo2,
  cancelled: Ban,
};

/** One friendly line under the status: what happens next. */
const NEXT_STEP: Record<string, string> = {
  placed: "We'll call you shortly to confirm your order.",
  awaiting_call: "We couldn't reach you. Please keep your phone close — we'll call again.",
  confirmed: "Your order is confirmed and being prepared.",
  booked: "Your parcel is booked with Steadfast and being packed.",
  packed: "Packed and waiting for the courier to pick it up.",
  shipped: "Your parcel is on the way. The rider will call before delivery.",
  on_hold: "Delivery is paused for now. We'll be in touch.",
  delivered: "Thank you for shopping with us!",
  returned: "This parcel is coming back to us.",
  cancelled: "This order won't be delivered.",
};

function eventIcon(kind: string): LucideIcon {
  if (kind === "placed") return ShoppingBag;
  if (kind === "call_confirmed") return Check;
  if (kind === "call_no_answer") return PhoneMissed;
  if (kind === "call_call_again") return Phone;
  if (kind === "call_rejected" || kind === "cancelled" || kind === "courier_cancelled") return Ban;
  if (kind === "booked") return Package;
  if (kind === "packed") return PackageCheck;
  if (kind === "picked_up" || kind === "courier_update") return Truck;
  if (kind === "delivered") return CheckCircle2;
  if (kind === "returned") return Undo2;
  if (kind === "on_hold") return Clock;
  return Truck;
}

export default function Track() {
  const { token = "" } = useParams();
  const [data, setData] = useState<TrackingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/public/track/${encodeURIComponent(token)}`);
      if (r.status === 404) setError("This tracking link is not valid. Please check the link or contact us.");
      else if (!r.ok) throw new Error();
      else {
        setData(await r.json());
        setError(null);
      }
    } catch {
      setError((e) => e ?? "Couldn't load tracking right now. Please try again in a moment.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (data) document.title = `${data.order.name} · ${data.status.title} — ${data.business.name}`;
  }, [data]);

  if (!data) {
    return (
      <div className="trk" style={{ display: "grid", placeItems: "center", padding: 24 }}>
        {error ? <Text ta="center" c="dimmed" maw={360}>{error}</Text> : <Loader />}
      </div>
    );
  }

  const tone = data.status.tone;
  const accent = TONE_COLOR[tone];
  const StatusIcon = STATUS_ICON[data.status.key] ?? Package;
  const stopped = data.status.key === "cancelled" || data.status.key === "returned";
  const doneCount = data.steps.filter((s) => s.done).length;
  const currentIndex = Math.max(0, doneCount - 1);

  return (
    <div className="trk" style={{ ["--trk-accent" as string]: accent }}>
      {/* Hero */}
      <header className="trk-hero" data-tone={tone === "info" ? undefined : tone}>
        <div className="trk-wrap">
          <Group justify="space-between" mb={28}>
            <Text fw={800} fz={18} style={{ letterSpacing: 1.2 }}>{data.business.name}</Text>
            <span className="trk-pill"><Package size={13} /> {data.order.name}</span>
          </Group>
          <Group gap="md" wrap="nowrap" align="center">
            <div className="trk-status-icon"><StatusIcon size={26} /></div>
            <div>
              <Text fz={13} opacity={0.85} fw={500}>Order status</Text>
              <Text fz={{ base: 24, sm: 28 }} fw={800} lh={1.15}>{data.status.title}</Text>
            </div>
          </Group>
          <Text mt="md" fz={15} opacity={0.92}>{NEXT_STEP[data.status.key] ?? ""}</Text>
        </div>
      </header>

      <main className="trk-wrap" style={{ paddingBottom: 40 }}>
        <Stack gap="md">
          {/* Progress */}
          <section className="trk-card trk-overlap">
            {!stopped ? (
              <div className="trk-steps">
                <div className="trk-steps-fill" style={{ width: `${(currentIndex / (data.steps.length - 1)) * 80}%` }} />
                {data.steps.map((s, i) => {
                  const Icon = STEP_ICON[s.key] ?? Check;
                  return (
                    <div key={s.key} className="trk-step" data-done={s.done} data-current={i === currentIndex && data.status.key !== "delivered"}>
                      <div className="trk-dot"><Icon size={16} /></div>
                      <Text fz={12} fw={s.done ? 700 : 500} c={s.done ? undefined : "dimmed"} lh={1.2}>{s.label}</Text>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Group gap="sm" wrap="nowrap">
                <StatusIcon size={20} color={accent} />
                <Text fw={600}>{data.status.title}</Text>
              </Group>
            )}
            {data.order.codDue > 0 && !stopped && (
              <div className="trk-cod">
                <div>
                  <Text fz={13} fw={600}>Cash on delivery</Text>
                  <Text fz={12} c="dimmed">Please keep the exact amount ready</Text>
                </div>
                <Text fz={24} fw={800} style={{ fontVariantNumeric: "tabular-nums" }}>{money(data.order.codDue)}</Text>
              </div>
            )}
            {data.order.shipsWith.length > 0 && (
              <Text fz={13} c="dimmed" mt="sm">Your orders {[data.order.name, ...data.order.shipsWith].join(" + ")} travel together in one parcel.</Text>
            )}
          </section>

          {/* Timeline */}
          <section className="trk-card">
            <Group justify="space-between" mb="md">
              <Text fw={700} fz={16}>Updates</Text>
              <UnstyledButton onClick={() => void load()} aria-label="Refresh" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--mantine-color-dimmed)" }}>
                <RefreshCw size={13} className={loading ? "spin" : undefined} /> {ago(data.updatedAt)}
              </UnstyledButton>
            </Group>
            {data.timeline.map((e, i) => {
              const Icon = eventIcon(e.kind);
              return (
                <div key={`${e.kind}-${e.at}-${i}`} className="trk-event" data-first={i === 0}>
                  <div className="trk-event-dot" style={i === 0 ? { background: TONE_COLOR[e.tone] } : undefined}><Icon size={14} /></div>
                  <div>
                    <Text fz={14} fw={i === 0 ? 700 : 500} lh={1.35}>{e.title}</Text>
                    {e.detail && <Text fz={13} c="dimmed">{e.detail}</Text>}
                    <Text fz={12} c="dimmed" mt={2}>{dateTime(e.at)} · {ago(e.at)}</Text>
                  </div>
                </div>
              );
            })}
          </section>

          {/* Courier */}
          {data.courier && (
            <section className="trk-card">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <div className="trk-event-dot" style={{ width: 40, height: 40, borderRadius: 12, background: "var(--trk-soft)", color: accent }}><Truck size={18} /></div>
                  <div>
                    <Text fw={700} fz={14}>{data.courier.name}</Text>
                    <Text fz={12} c="dimmed">Courier partner</Text>
                  </div>
                </Group>
                {data.courier.trackingCode && (
                  <CopyButton value={data.courier.trackingCode}>
                    {({ copied, copy }) => (
                      <Tooltip label={copied ? "Copied" : "Copy tracking code"}>
                        <UnstyledButton onClick={copy} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 10, background: "var(--trk-soft)" }}>
                          <Text fz={13} className="mono" fw={600}>{data.courier?.trackingCode}</Text>
                          {copied ? <Check size={14} /> : <Copy size={14} />}
                        </UnstyledButton>
                      </Tooltip>
                    )}
                  </CopyButton>
                )}
              </Group>
            </section>
          )}

          {/* Order */}
          <section className="trk-card">
            <Text fw={700} fz={16} mb="sm">Your order</Text>
            <Stack gap={10}>
              {data.order.items.map((it, i) => (
                <Group key={i} justify="space-between" wrap="nowrap" align="flex-start">
                  <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                    <div className="trk-event-dot" style={{ width: 34, height: 34, flexShrink: 0 }}><Text fz={12} fw={700}>{it.quantity}×</Text></div>
                    <div style={{ minWidth: 0 }}>
                      <Text fz={14} fw={600} lineClamp={2}>{it.title}</Text>
                      {it.variant && <Text fz={12} c="dimmed">{it.variant}</Text>}
                    </div>
                  </Group>
                  <Text fz={14} style={{ whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{money(it.price * it.quantity)}</Text>
                </Group>
              ))}
            </Stack>
            <Stack gap={6} mt="md" pt="md" style={{ borderTop: "1px solid var(--trk-line)" }}>
              <Row label="Subtotal" value={money(data.order.subtotal)} />
              {data.order.discount > 0 && <Row label="Discount" value={`−${money(data.order.discount)}`} />}
              <Row label="Delivery" value={money(data.order.shipping)} />
              <Row label="Total" value={money(data.order.total)} strong />
            </Stack>
            {(data.customer.address || data.customer.name) && (
              <Group gap="sm" wrap="nowrap" align="flex-start" mt="md" pt="md" style={{ borderTop: "1px solid var(--trk-line)" }}>
                <MapPin size={18} color={accent} style={{ marginTop: 2, flexShrink: 0 }} />
                <div>
                  <Text fz={14} fw={600}>{data.customer.name}</Text>
                  <Text fz={13} c="dimmed">{[data.customer.address, data.customer.city].filter(Boolean).join(", ")}</Text>
                  {data.customer.phone && <Text fz={12} c="dimmed" className="mono">{data.customer.phone}</Text>}
                </div>
              </Group>
            )}
          </section>

          {data.business.phone && (
            <a
              href={`tel:${data.business.phone}`}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "14px 16px", borderRadius: 16, background: accent, color: "#fff", fontWeight: 700, textDecoration: "none" }}
            >
              <Phone size={18} /> Call {data.business.name}
            </a>
          )}
          <Text ta="center" fz={12} c="dimmed">Placed {dateTime(data.order.placedAt)} · updates every minute</Text>
        </Stack>
      </main>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Group justify="space-between">
      <Text fz={strong ? 15 : 14} fw={strong ? 800 : 400} c={strong ? undefined : "dimmed"}>{label}</Text>
      <Text fz={strong ? 15 : 14} fw={strong ? 800 : 500} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</Text>
    </Group>
  );
}
