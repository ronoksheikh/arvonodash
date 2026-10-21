import { useState } from "react";
import { Button, Card, Group, ScrollArea, SegmentedControl, SimpleGrid, Stack, Table, Text, Title } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useQuery } from "@tanstack/react-query";
import { Printer } from "lucide-react";
import { api, qs } from "../api";
import { dhakaToday, EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui";
import { day, money, num } from "../format";
import { channelInfo, SourceBadge } from "../components/Source";

type Report = {
  from: string;
  to: string;
  returnsWindowFrom: string;
  orders: { received: number; value: number; confirmed: number; rejected: number; cancelled: number; pending: number; newCustomers: number; confirmRate: number | null };
  courier: { booked: number; dispatched: number; delivered: number; returned: number; successRate: number | null };
  sameDay: { cutoffTime: string; beforeCutoff: number; sameDay: number; nextDay: number; notYet: number; rate: number | null; carriedOver: number; unscanned: number };
  money: { collected: number; deliveryCharges: number; paidOut: number; payouts: number; awaitingPayout: number; awaitingPayoutCount: number; withCourier: number; withCourierCount: number };
  sources: { channels: (SourceRow & { channel: string })[]; campaigns: (SourceRow & { campaign: string; channel: string })[] };
  worstDistricts: { city: string; delivered: number; returned: number; returnRate: number | null }[];
  worstProducts: { title: string; delivered: number; returned: number; returnRate: number | null }[];
  callers: { name: string; calls: number; confirmed: number; noAnswer: number; rejected: number }[];
};

type SourceRow = { orders: number; value: number; confirmed: number; cancelled: number; delivered: number; returned: number; deliveredValue: number; confirmRate: number | null; returnRate: number | null };

const PRESETS = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
];
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "good" | "bad" }) {
  return (
    <Card padding="md">
      <Text size="xs" c="dimmed" fw={500}>{label}</Text>
      <Text fz={26} fw={600} mt={4} lh={1.1} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</Text>
      {hint && <Text size="xs" c={tone === "bad" ? "red" : tone === "good" ? "teal" : "dimmed"} mt={6}>{hint}</Text>}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Stack gap="xs" mb="lg">
      <Title order={5} fw={600}>{title}</Title>
      {children}
    </Stack>
  );
}

export default function ReportPage() {
  const [preset, setPreset] = useState("today");
  const [custom, setCustom] = useState<[string | null, string | null]>([dhakaToday(-6), dhakaToday()]);
  const range =
    preset === "today" ? [dhakaToday(), dhakaToday()]
    : preset === "yesterday" ? [dhakaToday(-1), dhakaToday(-1)]
    : preset === "7" ? [dhakaToday(-6), dhakaToday()]
    : preset === "30" ? [dhakaToday(-29), dhakaToday()]
    : [custom[0] ?? dhakaToday(), custom[1] ?? custom[0] ?? dhakaToday()];
  const q = useQuery({ queryKey: ["report", range[0], range[1]], queryFn: () => api<Report>(`/ops/report${qs({ from: range[0], to: range[1] })}`), refetchInterval: 120_000 });
  const r = q.data;
  const title = range[0] === range[1] ? day(range[0]) : `${day(range[0])} – ${day(range[1])}`;

  return (
    <>
      <PageHeader
        title="Owner report"
        description={title}
        actions={
          <Group gap="xs" className="no-print">
            <SegmentedControl size="xs" value={preset} onChange={setPreset} data={PRESETS} />
            {preset === "custom" && (
              <DatePickerInput type="range" size="xs" w={230} valueFormat="D MMM" value={custom} onChange={(v) => setCustom([v[0] ? String(v[0]).slice(0, 10) : null, v[1] ? String(v[1]).slice(0, 10) : null])} />
            )}
            <Button size="xs" variant="default" leftSection={<Printer size={14} />} onClick={() => window.print()}>Print</Button>
          </Group>
        }
      />
      {q.isLoading ? <LoadingState /> : q.error || !r ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <Section title="Orders & calls">
            <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} spacing="xs">
              <Stat label="Orders received" value={num(r.orders.received)} hint={money(r.orders.value)} />
              <Stat label="Confirmed" value={num(r.orders.confirmed)} hint={`${pct(r.orders.confirmRate)} of orders`} />
              <Stat label="Rejected on call" value={num(r.orders.rejected)} />
              <Stat label="Cancelled" value={num(r.orders.cancelled)} />
              <Stat label="Still to call" value={num(r.orders.pending)} tone={r.orders.pending ? "bad" : undefined} hint={r.orders.pending ? "not decided yet" : "all decided"} />
              <Stat label="New customers" value={num(r.orders.newCustomers)} hint={`${num(r.orders.received - r.orders.newCustomers)} returning`} />
            </SimpleGrid>
          </Section>

          <Section title="Courier">
            <SimpleGrid cols={{ base: 2, sm: 3, lg: 7 }} spacing="xs">
              <Stat
                label="Missed pickups"
                value={num(r.sameDay.carriedOver)}
                tone={r.sameDay.carriedOver ? "bad" : undefined}
                hint={`parcel-days carried over${r.sameDay.unscanned ? ` · ${r.sameDay.unscanned} left without a packing scan` : ""}`}
              />
              <Stat label="Sent to courier" value={num(r.courier.booked)} />
              <Stat label="Picked up (dispatched)" value={num(r.courier.dispatched)} />
              <Stat label="Delivered" value={num(r.courier.delivered)} />
              <Stat label="Returned" value={num(r.courier.returned)} tone={r.courier.returned ? "bad" : undefined} hint={r.courier.returned ? "failed deliveries" : undefined} />
              <Stat label="Delivery success" value={pct(r.courier.successRate)} hint="delivered ÷ (delivered + returned)" />
              <Stat
                label={`Same-day dispatch (before ${r.sameDay.cutoffTime})`}
                value={pct(r.sameDay.rate)}
                hint={`${r.sameDay.sameDay}/${r.sameDay.beforeCutoff} same day · ${r.sameDay.nextDay} next day${r.sameDay.notYet ? ` · ${r.sameDay.notYet} not yet` : ""}`}
                tone={r.sameDay.notYet || r.sameDay.nextDay ? "bad" : undefined}
              />
            </SimpleGrid>
          </Section>

          <Section title="Money (COD)">
            <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }} spacing="xs">
              <Stat label="COD collected" value={money(r.money.collected)} hint="on parcels delivered in this period" />
              <Stat label="Delivery charges" value={money(r.money.deliveryCharges)} />
              <Stat label="Paid out by Steadfast" value={money(r.money.paidOut)} hint={`${r.money.payouts} payment(s)`} />
              <Stat label="Awaiting payout (now)" value={money(r.money.awaitingPayout)} hint={`${r.money.awaitingPayoutCount} delivered, not paid yet`} />
              <Stat label="With courier (now)" value={money(r.money.withCourier)} hint={`${r.money.withCourierCount} parcels on the way`} />
            </SimpleGrid>
          </Section>

          <Stack mb="lg">
          <Panel>
            <Text fw={600} p="md" pb={2}>Where orders come from</Text>
            <Text size="xs" c="dimmed" px="md" pb="xs">Orders placed in this period, by source (Shopify customer journey and UTM tags). Return rate = returned ÷ (delivered + returned).</Text>
            <SourceTable rows={r.sources.channels.map((x) => ({ key: x.channel, name: <SourceBadge channel={x.channel} />, ...x }))} />
            {r.sources.campaigns.length > 0 && (
              <>
                <Text fw={600} size="sm" px="md" pt="md" pb="xs">Top campaigns</Text>
                <SourceTable rows={r.sources.campaigns.map((x) => ({ key: x.campaign, name: <Group gap={6} wrap="nowrap"><Text size="sm" lineClamp={1}>{x.campaign}</Text><Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>{channelInfo(x.channel).label}</Text></Group>, ...x }))} />
              </>
            )}
          </Panel>
          </Stack>

          <SimpleGrid cols={{ base: 1, lg: 2 }} mb="lg">
            <Panel>
              <Text fw={600} p="md" pb={2}>Worst districts for returns</Text>
              <Text size="xs" c="dimmed" px="md" pb="xs">Parcels finished {day(r.returnsWindowFrom)} – {day(r.to)} · at least 3 parcels</Text>
              <RateTable rows={r.worstDistricts.map((d) => ({ name: d.city, ...d }))} label="District" />
            </Panel>
            <Panel>
              <Text fw={600} p="md" pb={2}>Worst products for returns</Text>
              <Text size="xs" c="dimmed" px="md" pb="xs">Parcels containing the product · same period</Text>
              <RateTable rows={r.worstProducts.map((p) => ({ name: p.title, ...p }))} label="Product" />
            </Panel>
          </SimpleGrid>

          <Panel>
            <Text fw={600} p="md" pb="xs">Calls by team member</Text>
            {r.callers.length === 0 ? <EmptyState title="No calls logged in this period" /> : (
              <Table className="app-table" verticalSpacing={8}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th pl="md">Who</Table.Th>
                    <Table.Th ta="right">Calls</Table.Th>
                    <Table.Th ta="right">Confirmed</Table.Th>
                    <Table.Th ta="right">No answer</Table.Th>
                    <Table.Th ta="right" pr="md">Rejected</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {r.callers.map((c) => (
                    <Table.Tr key={c.name} style={{ cursor: "default" }}>
                      <Table.Td pl="md"><Text size="sm">{c.name}</Text></Table.Td>
                      <Table.Td ta="right"><Text size="sm">{c.calls}</Text></Table.Td>
                      <Table.Td ta="right"><Text size="sm">{c.confirmed}</Text></Table.Td>
                      <Table.Td ta="right"><Text size="sm">{c.noAnswer}</Text></Table.Td>
                      <Table.Td ta="right" pr="md"><Text size="sm">{c.rejected}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </>
  );
}

function RateTable({ rows, label }: { rows: { name: string; delivered: number; returned: number; returnRate: number | null }[]; label: string }) {
  if (!rows.length) return <EmptyState title="No returns in this period" />;
  return (
    <Table className="app-table" verticalSpacing={8}>
      <Table.Thead>
        <Table.Tr>
          <Table.Th pl="md">{label}</Table.Th>
          <Table.Th ta="right">Delivered</Table.Th>
          <Table.Th ta="right">Returned</Table.Th>
          <Table.Th pr="md" w={170}>Return rate</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((d) => (
          <Table.Tr key={d.name} style={{ cursor: "default" }}>
            <Table.Td pl="md"><Text size="sm" lineClamp={1}>{d.name}</Text></Table.Td>
            <Table.Td ta="right"><Text size="sm">{d.delivered}</Text></Table.Td>
            <Table.Td ta="right"><Text size="sm">{d.returned}</Text></Table.Td>
            <Table.Td pr="md">
              <Group gap={8} wrap="nowrap">
                <div style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--app-muted-bg)" }}>
                  <div style={{ width: `${d.returnRate ?? 0}%`, height: 6, borderRadius: 3, background: "var(--mantine-color-red-6)" }} />
                </div>
                <Text size="sm" w={44} ta="right" style={{ fontVariantNumeric: "tabular-nums" }}>{pct(d.returnRate)}</Text>
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

function SourceTable({ rows }: { rows: (SourceRow & { key: string; name: React.ReactNode })[] }) {
  if (!rows.length) return <EmptyState title="No orders in this period" />;
  return (
    <ScrollArea>
      <Table className="app-table" verticalSpacing={8} miw={760}>
        <Table.Thead>
          <Table.Tr>
            <Table.Th pl="md">Source</Table.Th>
            <Table.Th ta="right">Orders</Table.Th>
            <Table.Th ta="right">Value</Table.Th>
            <Table.Th ta="right">Confirmed</Table.Th>
            <Table.Th ta="right">Cancelled</Table.Th>
            <Table.Th ta="right">Delivered</Table.Th>
            <Table.Th ta="right">Returned</Table.Th>
            <Table.Th ta="right" pr="md">Delivered value</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((x) => (
            <Table.Tr key={x.key} style={{ cursor: "default" }}>
              <Table.Td pl="md" maw={260}>{x.name}</Table.Td>
              <Table.Td ta="right"><Text size="sm" fw={600}>{num(x.orders)}</Text></Table.Td>
              <Table.Td ta="right"><Text size="sm">{money(x.value)}</Text></Table.Td>
              <Table.Td ta="right"><Text size="sm">{num(x.confirmed)} <Text span size="xs" c="dimmed">{pct(x.confirmRate)}</Text></Text></Table.Td>
              <Table.Td ta="right"><Text size="sm" c={x.cancelled ? "red" : undefined}>{num(x.cancelled)}</Text></Table.Td>
              <Table.Td ta="right"><Text size="sm">{num(x.delivered)}</Text></Table.Td>
              <Table.Td ta="right"><Text size="sm" c={(x.returnRate ?? 0) >= 30 ? "red" : undefined}>{num(x.returned)} <Text span size="xs" c="dimmed">{pct(x.returnRate)}</Text></Text></Table.Td>
              <Table.Td ta="right" pr="md"><Text size="sm">{money(x.deliveredValue)}</Text></Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </ScrollArea>
  );
}
