import { useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Checkbox, Group, Modal, ScrollArea, SegmentedControl, SimpleGrid, Stack, Switch, Table, Tabs, Text, Textarea, Timeline } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Printer, RotateCcw, Unlock } from "lucide-react";
import { api, notifyError, notifySuccess, post, qs } from "../api";
import { useCan } from "../auth";
import { dhakaToday, EmptyState, ErrorState, LabelBadge, LoadingState, PageHeader, Panel } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { ago, dateShort, dateTime, money, titleCase } from "../format";
import { DISPATCH_EVENTS } from "../../shared/constants";

type PrintableOrder = {
  orderId: number;
  orderName: string;
  invoice: string | null;
  consignmentId: string | null;
  trackingCode: string | null;
  customer: { name: string | null; phone: string | null };
  shippingAddress: { address: string | null };
  items: { title: string; variant: string | null; quantity: number }[];
  totalQuantity: number;
  codAmount: number;
  bookedAt: string | null;
  labelStatus: string;
  printJobId: string | null;
  reservedUntil: string | null;
  printedAt: string | null;
  printCount: number;
};
type Summary = {
  confirmedOrders: number;
  bookedConsignments: number;
  unprinted: number;
  reserved: number;
  printed: number;
  printedOnDate: number;
  awaitingSort: number;
  sorted: number;
  dispatched: number;
  cancelledAfterBooking: number;
  backlog: { unprinted: number; reserved: number; awaitingSort: number; awaitingPickup: number };
};
type Job = { id: string; source: string; status: string; orderCount: number; printedCount: number; expiresAt: string; createdAt: string; completedAt: string | null };

const JOB_COLOR: Record<string, string> = { reserved: "yellow", completed: "teal", partial: "orange", released: "gray", expired: "red" };

export default function PrintQueue() {
  const can = useCan();
  const qc = useQueryClient();
  const [date, setDate] = useState<string>(dhakaToday());
  const [includeEarlier, setIncludeEarlier] = useState(false);
  const [tab, setTab] = useState<string>("unprinted");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [reprintOpen, setReprintOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const rangeParams = includeEarlier ? { upTo: date } : { date };
  const summary = useQuery({ queryKey: ["dispatch-summary", date], queryFn: () => api<Summary>(`/v1/dispatch/summary${qs({ date })}`), refetchInterval: 20_000 });
  const list = useQuery({
    queryKey: ["printable", date, includeEarlier, tab],
    queryFn: () => api<{ orders: PrintableOrder[]; nextCursor: number | null }>(`/v1/dispatch/printable${qs({ ...rangeParams, status: tab, limit: 500 })}`),
    refetchInterval: 20_000,
  });
  const jobs = useQuery({ queryKey: ["print-jobs"], queryFn: () => api<{ jobs: Job[] }>("/v1/dispatch/jobs?limit=30"), refetchInterval: 30_000 });
  const rows = list.data?.orders ?? [];
  const refresh = () => {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["printable"] });
    qc.invalidateQueries({ queryKey: ["dispatch-summary"] });
    qc.invalidateQueries({ queryKey: ["print-jobs"] });
  };

  const release = useMutation({
    mutationFn: () => post<{ released: number }>("/v1/dispatch/release", { orderIds: [...selected], reason: "Released from dashboard" }),
    onSuccess: (r) => { notifySuccess(`${r.released} reservation(s) released`); refresh(); },
    onError: (e) => notifyError(e),
  });
  const reprint = useMutation({
    mutationFn: () => post<{ requeued: number[] }>("/v1/dispatch/reprint", { orderIds: [...selected], reason }),
    onSuccess: (r) => { notifySuccess(`${r.requeued.length} label(s) sent back to the print queue`); setReprintOpen(false); setReason(""); refresh(); },
    onError: (e) => notifyError(e),
  });

  const s = summary.data;
  const cards = useMemo(
    () => [
      { label: "Confirmed", value: s?.confirmedOrders, hint: "Calls confirmed this day" },
      { label: "Booked", value: s?.bookedConsignments, hint: "Consignments created" },
      { label: "Unprinted", value: s?.unprinted, color: "blue", hint: s?.backlog.unprinted ? `${s.backlog.unprinted} in total incl. other days` : undefined },
      { label: "Reserved", value: s?.reserved, color: "yellow", hint: "Claimed by a print job" },
      { label: "Printed", value: s?.printed, color: "teal" },
      { label: "To sort", value: s?.awaitingSort, color: "indigo" },
      { label: "Sorted", value: s?.sorted },
      { label: "Dispatched", value: s?.dispatched, color: "teal", hint: "Picked up by Steadfast" },
    ],
    [s],
  );

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.orderId));
  const toggle = (id: number) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };

  return (
    <>
      <PageHeader
        title="Ready to print"
        description="Booked parcels waiting for the label service. Labels become Printed only when the label service confirms them."
        actions={
          <Group gap="xs">
            <SegmentedControl size="xs" value={date === dhakaToday() ? "today" : date === dhakaToday(-1) ? "yesterday" : "custom"} onChange={(v) => v !== "custom" && setDate(dhakaToday(v === "today" ? 0 : -1))} data={[{ value: "yesterday", label: "Yesterday" }, { value: "today", label: "Today" }, { value: "custom", label: "Date", disabled: true }]} />
            <DatePickerInput value={date} onChange={(v) => v && setDate(String(v).slice(0, 10))} valueFormat="D MMM YYYY" w={150} size="xs" maxDate={dhakaToday(1)} />
          </Group>
        }
      />
      <SimpleGrid cols={{ base: 2, sm: 4, lg: 8 }} spacing="sm">
        {cards.map((c) => (
          <Card key={c.label} padding="sm">
            <Text size="xs" c="dimmed" fw={500}>{c.label}</Text>
            <Text fz={22} fw={600} c={c.color} style={{ fontVariantNumeric: "tabular-nums" }}>{c.value ?? "…"}</Text>
            {c.hint && <Text size="xs" c="dimmed" lineClamp={1}>{c.hint}</Text>}
          </Card>
        ))}
      </SimpleGrid>
      {s && s.cancelledAfterBooking > 0 && (
        <Alert color="red" variant="light" mt="md">{s.cancelledAfterBooking} order(s) booked this day were cancelled in Shopify — they are excluded from printing.</Alert>
      )}

      <Panel>
        <Tabs value={tab} onChange={(v) => { setTab(v ?? "unprinted"); setSelected(new Set()); }} mt="lg" px="md" pt={6}>
          <Tabs.List>
            <Tabs.Tab value="unprinted">Unprinted</Tabs.Tab>
            <Tabs.Tab value="reserved">Reserved</Tabs.Tab>
            <Tabs.Tab value="printed">Printed</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        <Group p="md" justify="space-between">
          <Switch label="Include earlier days (next-day dispatch backlog)" checked={includeEarlier} onChange={(e) => setIncludeEarlier(e.currentTarget.checked)} />
          <Group gap="xs">
            {tab === "reserved" && can("dispatch.manage") && (
              <Button size="xs" variant="default" leftSection={<Unlock size={14} />} disabled={!selected.size} loading={release.isPending} onClick={() => release.mutate()}>
                Release {selected.size || ""}
              </Button>
            )}
            {tab === "printed" && can("labels.reprint") && (
              <Button size="xs" variant="default" leftSection={<RotateCcw size={14} />} disabled={!selected.size} onClick={() => setReprintOpen(true)}>
                Request reprint {selected.size || ""}
              </Button>
            )}
          </Group>
        </Group>
        {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<Printer size={22} />} title={tab === "unprinted" ? "Nothing waiting to print" : `No ${tab} labels`} description={tab === "unprinted" ? "Confirm orders and book them with Steadfast — they appear here for the label service." : undefined} />
        ) : (
          <ScrollArea>
            <Table className="app-table" verticalSpacing={8} miw={980}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={40} pl="md">{tab !== "unprinted" && <Checkbox size="xs" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.orderId)))} aria-label="Select all" />}</Table.Th>
                  <Table.Th>Order</Table.Th>
                  <Table.Th>Tracking</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th>Items</Table.Th>
                  <Table.Th ta="right">COD</Table.Th>
                  <Table.Th>Booked</Table.Th>
                  <Table.Th pr="md">Label</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((o) => (
                  <Table.Tr key={o.orderId} data-selected={selected.has(o.orderId)} onClick={() => setOpenOrder(o.orderId)}>
                    <Table.Td pl="md" onClick={(e) => e.stopPropagation()}>{tab !== "unprinted" && <Checkbox size="xs" checked={selected.has(o.orderId)} onChange={() => toggle(o.orderId)} aria-label="Select" />}</Table.Td>
                    <Table.Td><Text size="sm" fw={600}>{o.orderName}</Text><Text size="xs" c="dimmed">{o.invoice}</Text></Table.Td>
                    <Table.Td><Text size="sm" className="mono">{o.trackingCode}</Text><Text size="xs" c="dimmed" className="mono">{o.consignmentId}</Text></Table.Td>
                    <Table.Td maw={260}><Text size="sm" lineClamp={1}>{o.customer.name}</Text><Text size="xs" c="dimmed" lineClamp={1}>{o.customer.phone} · {o.shippingAddress.address}</Text></Table.Td>
                    <Table.Td maw={220}><Text size="xs" lineClamp={2}>{o.items.map((i) => `${i.quantity}× ${i.title}${i.variant ? ` (${i.variant})` : ""}`).join(", ")}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm" fw={500}>{money(o.codAmount)}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{dateShort(o.bookedAt)}</Text></Table.Td>
                    <Table.Td pr="md">
                      <LabelBadge status={o.labelStatus} />
                      {o.labelStatus === "reserved" && o.reservedUntil && <Text size="xs" c="dimmed">until {dateShort(o.reservedUntil)}</Text>}
                      {o.labelStatus === "printed" && <Text size="xs" c="dimmed">{ago(o.printedAt)}{o.printCount > 1 ? ` · ×${o.printCount}` : ""}</Text>}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Panel>

      <Card mt="lg" padding={0}>
        <Group p="md" gap={8}><History size={16} /><Text fw={600}>Printing history</Text></Group>
        {jobs.data?.jobs.length ? (
          <ScrollArea>
            <Table className="app-table" verticalSpacing={8} miw={720}>
              <Table.Thead><Table.Tr><Table.Th pl="md">Job</Table.Th><Table.Th>Source</Table.Th><Table.Th>Status</Table.Th><Table.Th ta="right">Printed / reserved</Table.Th><Table.Th>Created</Table.Th><Table.Th pr="md">Expires</Table.Th></Table.Tr></Table.Thead>
              <Table.Tbody>
                {jobs.data.jobs.map((j) => (
                  <Table.Tr key={j.id} onClick={() => setJobId(j.id)}>
                    <Table.Td pl="md"><Text size="sm" className="mono">{j.id.slice(0, 8)}</Text></Table.Td>
                    <Table.Td><Text size="sm">{j.source}</Text></Table.Td>
                    <Table.Td><Badge size="sm" color={JOB_COLOR[j.status] ?? "gray"}>{titleCase(j.status)}</Badge></Table.Td>
                    <Table.Td ta="right"><Text size="sm">{j.printedCount} / {j.orderCount}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{dateTime(j.createdAt)}</Text></Table.Td>
                    <Table.Td pr="md"><Text size="xs" c="dimmed">{j.status === "reserved" ? dateShort(j.expiresAt) : "—"}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        ) : (
          <EmptyState title="No print jobs yet" description="Jobs appear when the label service claims orders." />
        )}
      </Card>

      <Modal opened={reprintOpen} onClose={() => setReprintOpen(false)} title={`Request reprint for ${selected.size} label(s)`}>
        <Stack>
          <Text size="sm" c="dimmed">The labels go back to Unprinted so the label service prints them again. The reason is kept in the order's history.</Text>
          <Textarea label="Reason" required autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} placeholder="e.g. Label damaged, printer jammed" />
          <Group justify="flex-end"><Button disabled={!reason.trim()} loading={reprint.isPending} onClick={() => reprint.mutate()}>Send to print queue</Button></Group>
        </Stack>
      </Modal>
      <JobModal jobId={jobId} onClose={() => setJobId(null)} />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={refresh} />
    </>
  );
}

function JobModal({ jobId, onClose }: { jobId: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["print-job", jobId],
    queryFn: () => api<{ job: Job; events: { id: number; event: string; orderName: string; actor: string; note: string | null; createdAt: string }[] }>(`/v1/dispatch/jobs/${jobId}`),
    enabled: jobId !== null,
  });
  return (
    <Modal opened={jobId !== null} onClose={onClose} title={`Print job ${jobId?.slice(0, 8) ?? ""}`} size="lg">
      {q.isLoading ? <LoadingState /> : q.data ? (
        <Timeline bulletSize={12} lineWidth={2}>
          {q.data.events.map((e) => (
            <Timeline.Item key={e.id} title={<Text size="sm"><b>{e.orderName}</b> · {DISPATCH_EVENTS[e.event] ?? e.event}</Text>}>
              <Text size="xs" c="dimmed">{e.actor} · {dateTime(e.createdAt)}{e.note ? ` · ${e.note}` : ""}</Text>
            </Timeline.Item>
          ))}
        </Timeline>
      ) : null}
    </Modal>
  );
}
