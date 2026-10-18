import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Anchor, Box, Button, Card, Container, Divider, Group, Loader, Stack, Text, ThemeIcon, Timeline, Title } from "@mantine/core";
import { Ban, Check, CheckCircle2, Clock, MapPin, Package, PackageCheck, Phone, PhoneMissed, PhoneOff, ShoppingBag, Truck, Undo2 } from "lucide-react";
import { dateTime, money } from "../format";

type Tone = "info" | "good" | "warn" | "bad";
type TrackingData = {
  business: { name: string; phone: string | null };
  order: { name: string; placedAt: string; currency: string; items: { title: string; variant: string | null; quantity: number; price: number }[]; subtotal: number; shipping: number; discount: number; total: number; codDue: number };
  customer: { name: string | null; phone: string | null; address: string | null; city: string | null };
  courier: { name: string; trackingCode: string | null; consignmentId: string | null } | null;
  status: { key: string; title: string; tone: Tone };
  steps: { key: string; label: string; done: boolean; at: string | null }[];
  timeline: { at: string; kind: string; title: string; detail?: string | null; tone: Tone }[];
  updatedAt: string;
};

const TONE_COLOR: Record<Tone, string> = { info: "blue", good: "teal", warn: "orange", bad: "red" };

function eventIcon(kind: string) {
  if (kind === "placed") return <ShoppingBag size={13} />;
  if (kind === "call_confirmed") return <Check size={13} />;
  if (kind === "call_no_answer") return <PhoneMissed size={13} />;
  if (kind === "call_call_again") return <Phone size={13} />;
  if (kind === "call_rejected" || kind === "cancelled" || kind === "courier_cancelled") return <Ban size={13} />;
  if (kind === "booked") return <Package size={13} />;
  if (kind === "packed") return <PackageCheck size={13} />;
  if (kind === "picked_up" || kind === "courier_update") return <Truck size={13} />;
  if (kind === "delivered") return <CheckCircle2 size={13} />;
  if (kind === "returned") return <Undo2 size={13} />;
  if (kind === "on_hold") return <Clock size={13} />;
  return <PhoneOff size={13} />;
}

export default function Track() {
  const { token = "" } = useParams();
  const [data, setData] = useState<TrackingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/public/track/${encodeURIComponent(token)}`)
        .then(async (r) => {
          if (!alive) return;
          if (r.status === 404) return setError("This tracking link is not valid. Please check the link or contact us.");
          if (!r.ok) throw new Error();
          setData(await r.json());
          setError(null);
        })
        .catch(() => alive && setError((e) => e ?? "Couldn't load tracking right now. Please try again in a moment."));
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token]);

  useEffect(() => {
    if (data) document.title = `${data.order.name} · ${data.status.title} — ${data.business.name}`;
  }, [data]);

  if (!data) {
    return (
      <Container size={560} py={60}>
        {error ? <Text ta="center" c="dimmed">{error}</Text> : <Group justify="center"><Loader /></Group>}
      </Container>
    );
  }

  const color = TONE_COLOR[data.status.tone];
  const cancelled = data.status.tone === "bad";
  const doneCount = data.steps.filter((s) => s.done).length;

  return (
    <Box mih="100dvh" bg="var(--app-bg)" py={{ base: "md", sm: 40 }}>
      <Container size={560} px="md">
        <Stack gap="md">
          <Group justify="space-between">
            <Text fw={800} fz="lg" style={{ letterSpacing: 0.6 }}>{data.business.name}</Text>
            <Text size="sm" c="dimmed">Order tracking</Text>
          </Group>

          {/* Current status */}
          <Card radius="lg" p="lg" withBorder style={{ borderTop: `4px solid var(--mantine-color-${color}-6)` }}>
            <Text size="sm" c="dimmed">Order {data.order.name}</Text>
            <Title order={2} fz={24} mt={4} c={`${color}.7`}>{data.status.title}</Title>
            <Text size="xs" c="dimmed" mt={4}>Placed {dateTime(data.order.placedAt)}</Text>

            {!cancelled && (
              <Box mt="lg">
                <Box style={{ position: "relative", height: 6, borderRadius: 3, background: "var(--mantine-color-gray-3)" }}>
                  <Box style={{ position: "absolute", inset: 0, width: `${((doneCount - 1) / (data.steps.length - 1)) * 100}%`, borderRadius: 3, background: `var(--mantine-color-${color}-6)`, transition: "width 300ms" }} />
                </Box>
                <Group justify="space-between" mt={8} wrap="nowrap" gap={4}>
                  {data.steps.map((s) => (
                    <Text key={s.key} size="xs" fw={s.done ? 600 : 400} c={s.done ? undefined : "dimmed"} ta="center" style={{ flex: 1 }}>{s.label}</Text>
                  ))}
                </Group>
              </Box>
            )}

            {data.order.codDue > 0 && !cancelled && (
              <Group mt="lg" justify="space-between" p="sm" style={{ borderRadius: 10, background: "var(--mantine-color-yellow-light)" }}>
                <Text size="sm" fw={500}>Cash on delivery</Text>
                <Text fw={800} fz="lg">{money(data.order.codDue)}</Text>
              </Group>
            )}
          </Card>

          {/* History */}
          <Card radius="lg" p="lg" withBorder>
            <Text fw={700} mb="md">Updates</Text>
            <Timeline bulletSize={24} lineWidth={2} active={0}>
              {data.timeline.map((e, i) => (
                <Timeline.Item key={`${e.kind}-${e.at}-${i}`} bullet={eventIcon(e.kind)} color={TONE_COLOR[e.tone]} title={<Text size="sm" fw={i === 0 ? 700 : 500}>{e.title}</Text>}>
                  {e.detail && <Text size="xs" c="dimmed">{e.detail}</Text>}
                  <Text size="xs" c="dimmed">{dateTime(e.at)}</Text>
                </Timeline.Item>
              ))}
            </Timeline>
          </Card>

          {/* Courier */}
          {data.courier && (
            <Card radius="lg" p="lg" withBorder>
              <Group gap="sm" wrap="nowrap">
                <ThemeIcon variant="light" size="lg" radius="md"><Truck size={18} /></ThemeIcon>
                <div>
                  <Text fw={600} size="sm">{data.courier.name}</Text>
                  <Text size="xs" c="dimmed" className="mono">
                    {data.courier.trackingCode ? `Tracking ${data.courier.trackingCode}` : ""}
                    {data.courier.consignmentId ? ` · ID ${data.courier.consignmentId}` : ""}
                  </Text>
                </div>
              </Group>
            </Card>
          )}

          {/* Order details */}
          <Card radius="lg" p="lg" withBorder>
            <Text fw={700} mb="sm">Your order</Text>
            <Stack gap={8}>
              {data.order.items.map((it, i) => (
                <Group key={i} justify="space-between" wrap="nowrap" align="flex-start">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={500}>{it.title}</Text>
                    {it.variant && <Text size="xs" c="dimmed">{it.variant}</Text>}
                  </div>
                  <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>{it.quantity} × {money(it.price)}</Text>
                </Group>
              ))}
            </Stack>
            <Divider my="sm" />
            <Stack gap={4}>
              <Group justify="space-between"><Text size="sm" c="dimmed">Subtotal</Text><Text size="sm">{money(data.order.subtotal)}</Text></Group>
              {data.order.discount > 0 && <Group justify="space-between"><Text size="sm" c="dimmed">Discount</Text><Text size="sm">−{money(data.order.discount)}</Text></Group>}
              <Group justify="space-between"><Text size="sm" c="dimmed">Delivery</Text><Text size="sm">{money(data.order.shipping)}</Text></Group>
              <Group justify="space-between"><Text fw={700}>Total</Text><Text fw={700}>{money(data.order.total)}</Text></Group>
            </Stack>
            {(data.customer.address || data.customer.name) && (
              <>
                <Divider my="sm" />
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <MapPin size={16} style={{ marginTop: 2, flexShrink: 0 }} />
                  <div>
                    <Text size="sm" fw={500}>{data.customer.name}</Text>
                    <Text size="sm" c="dimmed">{[data.customer.address, data.customer.city].filter(Boolean).join(", ")}</Text>
                    {data.customer.phone && <Text size="xs" c="dimmed" className="mono">{data.customer.phone}</Text>}
                  </div>
                </Group>
              </>
            )}
          </Card>

          {data.business.phone && (
            <Button component="a" href={`tel:${data.business.phone}`} variant="light" size="md" radius="md" leftSection={<Phone size={16} />}>
              Call {data.business.name}
            </Button>
          )}
          <Text ta="center" size="xs" c="dimmed">
            Updated {dateTime(data.updatedAt)} · <Anchor size="xs" onClick={() => window.location.reload()}>Refresh</Anchor>
          </Text>
        </Stack>
      </Container>
    </Box>
  );
}
