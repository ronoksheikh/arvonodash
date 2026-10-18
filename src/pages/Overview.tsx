import { useState } from "react";
import { Card, Grid, Group, SegmentedControl, SimpleGrid, Stack, Text, Badge, Table, Anchor, Progress, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { AlertTriangle, ArrowRight, Clock } from "lucide-react";
import { api } from "../api";
import { ErrorState, LoadingState, PageHeader, StageBadge, EmptyState } from "../components/ui";
import { ago, money, num, titleCase } from "../format";
import { RISK_FLAGS } from "../../shared/constants";
import type { Activity } from "../types";

type Dashboard = {
  days: number;
  today: { orders: number; revenue: number };
  pipeline: { unbooked: number; booked: number; inTransit: number; delivered: number; returned: number; attention: number };
  oldestUnbookedAt: string | null;
  cod: { booked: number; collected: number; inTransit: number; settled: number; deliveryCharges: number };
  successRate: number | null;
  deliveredCount: number;
  returnedCount: number;
  trend: { day: string; orders: number; revenue: number; cancelled: number; delivered: number; returned: number }[];
  needsAttention: { id: number; name: string; customerName: string | null; courierStage: string; fulfillmentState: string; riskFlags: string[] | null; cancelledAt: string | null; shopCreatedAt: string; total: number }[];
  recentActivity: Activity[];
};

function Stat({ label, value, hint, onClick, accent }: { label: string; value: string; hint?: string; onClick?: () => void; accent?: string }) {
  return (
    <Card onClick={onClick} style={{ cursor: onClick ? "pointer" : undefined }} padding="md">
      <Text size="xs" c="dimmed" fw={500}>{label}</Text>
      <Text fz={26} fw={600} mt={4} lh={1.1} c={accent} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</Text>
      {hint && <Text size="xs" c="dimmed" mt={6}>{hint}</Text>}
    </Card>
  );
}

/** Single-series daily bar chart with hover tooltips. */
function OrdersChart({ data }: { data: Dashboard["trend"] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!data.length) return <EmptyState title="No orders in this period" />;
  const w = 720;
  const h = 180;
  const pad = { top: 12, bottom: 24, left: 32, right: 8 };
  const max = Math.max(1, ...data.map((d) => d.orders));
  const step = (w - pad.left - pad.right) / data.length;
  const barW = Math.max(3, Math.min(28, step - 2));
  const y = (v: number) => h - pad.bottom - (v / max) * (h - pad.top - pad.bottom);
  const ticks = [0, Math.round(max / 2), max];
  const active = hover !== null ? data[hover] : null;
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" role="img" aria-label="Orders per day" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} stroke="var(--app-border)" strokeWidth={1} />
            <text x={pad.left - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--mantine-color-dimmed)">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.left + i * step + (step - barW) / 2;
          const top = y(d.orders);
          const bh = Math.max(0, h - pad.bottom - top);
          const r = Math.min(4, barW / 2, bh);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={pad.left + i * step} y={pad.top} width={step} height={h - pad.top - pad.bottom} fill="transparent" />
              {bh > 0 && (
                <path
                  className="chart-bar"
                  d={`M${x},${h - pad.bottom} v${-(bh - r)} q0,${-r} ${r},${-r} h${barW - 2 * r} q${r},0 ${r},${r} v${bh - r} z`}
                  fill="var(--mantine-color-brand-filled)"
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {(i === 0 || i === data.length - 1 || i % Math.ceil(data.length / 6) === 0) && (
                <text x={x + barW / 2} y={h - 6} textAnchor="middle" fontSize={10} fill="var(--mantine-color-dimmed)">
                  {d.day.slice(5).replace("-", "/")}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {active && hover !== null && (
        <Card
          shadow="md"
          padding="xs"
          style={{ position: "absolute", top: 0, left: `${Math.min(80, ((hover + 0.5) / data.length) * 100)}%`, pointerEvents: "none", minWidth: 150 }}
        >
          <Text size="xs" fw={600}>{active.day}</Text>
          <Text size="xs">Orders: <b>{active.orders}</b></Text>
          <Text size="xs">Revenue: <b>{money(active.revenue)}</b></Text>
          <Text size="xs" c="dimmed">Delivered {active.delivered} · Returned {active.returned} · Cancelled {active.cancelled}</Text>
        </Card>
      )}
    </div>
  );
}

function attentionReason(o: Dashboard["needsAttention"][number]) {
  if (o.fulfillmentState === "failed") return "Shopify fulfillment failed";
  if (o.cancelledAt && o.courierStage !== "unbooked") return "Cancelled in Shopify after booking";
  if (o.courierStage === "issue") return "Courier issue — needs support";
  if (o.courierStage === "on_hold") return "Parcel on hold";
  return (o.riskFlags ?? []).map((f) => RISK_FLAGS[f] ?? f)[0] ?? "Review";
}

export default function Overview() {
  const [days, setDays] = useState("30");
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["dashboard", days], queryFn: () => api<Dashboard>(`/dashboard?days=${days}`), refetchInterval: 60_000 });

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const codTotal = Math.max(1, d.cod.booked);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live numbers from Shopify orders and Steadfast consignments"
        actions={<SegmentedControl size="xs" value={days} onChange={setDays} data={[{ value: "7", label: "7d" }, { value: "30", label: "30d" }, { value: "90", label: "90d" }]} />}
      />
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="md">
        <Stat label="Today's orders" value={num(d.today.orders)} hint={`${money(d.today.revenue)} revenue`} onClick={() => navigate("/orders")} />
        <Stat
          label="Pending booking"
          value={num(d.pipeline.unbooked)}
          hint={d.oldestUnbookedAt ? `Oldest ${ago(d.oldestUnbookedAt)}` : "All caught up"}
          onClick={() => navigate("/orders?tab=unbooked")}
          accent={d.pipeline.unbooked ? "brand" : undefined}
        />
        <Stat label="Booked" value={num(d.pipeline.booked)} hint="Awaiting pickup" onClick={() => navigate("/orders?tab=booked")} />
        <Stat label="In transit" value={num(d.pipeline.inTransit)} hint="Incl. on hold" onClick={() => navigate("/orders?tab=in_transit")} />
        <Stat label={`Delivered (${d.days}d)`} value={num(d.pipeline.delivered)} onClick={() => navigate("/orders?tab=delivered")} />
        <Stat label={`Returned (${d.days}d)`} value={num(d.pipeline.returned)} onClick={() => navigate("/orders?tab=returned")} accent={d.pipeline.returned ? "red" : undefined} />
      </SimpleGrid>

      <Grid gap="md" mt="md">
        <Grid.Col span={{ base: 12, lg: 8 }}>
        <Card h="100%">
          <Group justify="space-between" mb="sm">
            <div>
              <Text fw={600}>Orders per day</Text>
              <Text size="xs" c="dimmed">Business days in Asia/Dhaka</Text>
            </div>
            <Text size="sm" c="dimmed">{num(d.trend.reduce((s, t) => s + t.orders, 0))} orders · {money(d.trend.reduce((s, t) => s + t.revenue, 0))}</Text>
          </Group>
          <OrdersChart data={d.trend} />
        </Card>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 4 }}>
        <Card h="100%">
          <Text fw={600}>Delivery success</Text>
          <Text size="xs" c="dimmed">Delivered ÷ (delivered + returned), {d.days}d</Text>
          <Text fz={40} fw={600} mt="md" lh={1}>{d.successRate === null ? "—" : `${d.successRate}%`}</Text>
          <Text size="sm" c="dimmed" mt={6}>{d.deliveredCount} delivered · {d.returnedCount} returned</Text>
          {d.successRate !== null && (
            <Progress.Root size="md" mt="md">
              <Progress.Section value={d.successRate} color="teal" />
              <Progress.Section value={100 - d.successRate} color="red.4" />
            </Progress.Root>
          )}
          <Stack gap={6} mt="xl">
            <Text fw={600} size="sm">COD ({d.days}d)</Text>
            {[
              { label: "Booked", value: d.cod.booked },
              { label: "Collected", value: d.cod.collected, color: "teal" },
              { label: "With courier", value: d.cod.inTransit, color: "indigo" },
              { label: "Settled by Steadfast", value: d.cod.settled, color: "brand" },
              { label: "Delivery charges", value: d.cod.deliveryCharges, color: "gray" },
            ].map((r) => (
              <div key={r.label}>
                <Group justify="space-between">
                  <Text size="sm" c="dimmed">{r.label}</Text>
                  <Text size="sm" fw={500} style={{ fontVariantNumeric: "tabular-nums" }}>{money(r.value)}</Text>
                </Group>
                {r.color && <Progress value={(r.value / codTotal) * 100} size={4} color={r.color} mt={4} />}
              </div>
            ))}
          </Stack>
        </Card>
        </Grid.Col>
      </Grid>

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md" mt="md">
        <Card padding={0}>
          <Group justify="space-between" p="md" pb="xs">
            <Group gap={8}>
              <AlertTriangle size={16} color="var(--mantine-color-orange-6)" />
              <Text fw={600}>Needs attention</Text>
              <Badge color="orange" size="sm">{d.pipeline.attention}</Badge>
            </Group>
            <Anchor size="sm" onClick={() => navigate("/orders?tab=attention")}>
              View all <ArrowRight size={12} />
            </Anchor>
          </Group>
          {d.needsAttention.length === 0 ? (
            <EmptyState title="Nothing needs attention" description="Flagged, held and failed orders show up here." />
          ) : (
            <Table verticalSpacing="sm" className="app-table">
              <Table.Tbody>
                {d.needsAttention.map((o) => (
                  <Table.Tr key={o.id} onClick={() => navigate(`/orders?open=${o.id}`)}>
                    <Table.Td pl="md">
                      <Text size="sm" fw={600}>{o.name}</Text>
                      <Text size="xs" c="dimmed">{o.customerName}</Text>
                    </Table.Td>
                    <Table.Td><Text size="sm" c="orange.7">{attentionReason(o)}</Text></Table.Td>
                    <Table.Td pr="md" ta="right"><StageBadge stage={o.courierStage} /></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Card>
        <Card padding={0}>
          <Group justify="space-between" p="md" pb="xs">
            <Group gap={8}>
              <Clock size={16} />
              <Text fw={600}>Recent activity</Text>
            </Group>
            <Anchor size="sm" onClick={() => navigate("/activity")}>Activity log <ArrowRight size={12} /></Anchor>
          </Group>
          {d.recentActivity.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <Stack gap={0} pb="xs">
              {d.recentActivity.map((a) => (
                <Group key={a.id} justify="space-between" px="md" py={8} wrap="nowrap" style={{ borderTop: "1px solid var(--app-border)", cursor: a.orderId ? "pointer" : undefined }} onClick={() => a.orderId && navigate(`/orders?open=${a.orderId}`)}>
                  <Text size="sm" lineClamp={1}>
                    <Text span fw={500}>{a.actor}</Text> <Text span c="dimmed">{titleCase(a.action.split(".").pop())}</Text>
                    {a.entityId && a.entityType !== "user" && <Text span c="dimmed"> · {a.entityId}</Text>}
                  </Text>
                  <Tooltip label={new Date(a.createdAt).toLocaleString()}>
                    <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{ago(a.createdAt)}</Text>
                  </Tooltip>
                </Group>
              ))}
            </Stack>
          )}
        </Card>
      </SimpleGrid>
    </>
  );
}
