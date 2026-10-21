import { useState } from "react";
import { Badge, Button, Checkbox, Group, Modal, ScrollArea, Stack, Switch, Table, Tabs, Text, Textarea, Alert } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck, ScanLine, Truck, Undo2 } from "lucide-react";
import { useNavigate } from "react-router";
import { api, notifyError, notifySuccess, post, qs } from "../api";
import { useCan } from "../auth";
import { dhakaToday, EmptyState, ErrorState, FulfillmentBadge, LoadingState, PageHeader, Panel, StageBadge, SteadfastStatusBadge } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { ago, dateShort, money } from "../format";

type BoardRow = {
  orderId: number;
  orderName: string;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  codAmount: number;
  trackingCode: string | null;
  consignmentId: string | null;
  courierStatus: string | null;
  courierStage: string;
  lastMessage: string | null;
  cancelledAt: string | null;
  bookedAt: string | null;
  printedAt: string | null;
  sortedAt: string | null;
  sortedBy: string | null;
  dispatchedAt: string | null;
  fulfillmentState: string;
};

const VIEWS = [
  { value: "ready", label: "To sort" },
  { value: "sorted", label: "Sorted · awaiting pickup" },
  { value: "dispatched", label: "Dispatched" },
  { value: "exceptions", label: "Exceptions" },
];

export default function Dispatch() {
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [view, setView] = useState("ready");
  const [date, setDate] = useState(dhakaToday());
  const [allDates, setAllDates] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [undoOpen, setUndoOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [openOrder, setOpenOrder] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["dispatch-board", view, allDates ? null : date],
    queryFn: () => api<{ orders: BoardRow[]; counts: { ready: number; sorted: number } }>(`/v1/dispatch/board${qs({ view, date: allDates ? undefined : date })}`),
    refetchInterval: 20_000,
  });
  const rows = q.data?.orders ?? [];
  const refresh = () => {
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ["dispatch-board"] });
    qc.invalidateQueries({ queryKey: ["dispatch-summary"] });
  };

  const dispatch = useMutation({
    mutationFn: () => post<{ sorted: number; results: { orderId: number; result: string }[] }>("/v1/dispatch/mark-sorted", { orderIds: [...selected] }),
    onSuccess: (r) => {
      const skipped = r.results.filter((x) => x.result !== "sorted");
      notifySuccess(`${r.sorted} parcel(s) marked sorted${skipped.length ? ` · ${skipped.length} skipped (${skipped[0].result.replace(/_/g, " ")})` : ""}`);
      refresh();
    },
    onError: (e) => notifyError(e),
  });
  const undo = useMutation({
    mutationFn: () => post<{ reverted: number[] }>("/v1/dispatch/undo-sort", { orderIds: [...selected], reason }),
    onSuccess: (r) => { notifySuccess(`${r.reverted.length} parcel(s) moved back to To sort`); setUndoOpen(false); setReason(""); refresh(); },
    onError: (e) => notifyError(e),
  });

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.orderId));
  const toggle = (id: number) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };
  const selectable = view === "ready" || view === "sorted";

  return (
    <>
      <PageHeader
        title="Dispatch"
        description="Scan each label at the packing table to mark it sorted. It becomes Dispatched automatically when the courier confirms the pickup, which also fulfills the order in Shopify."
        actions={
          <Group gap="xs">
            {can("dispatch.manage") && <Button leftSection={<ScanLine size={15} />} onClick={() => navigate("/scan")}>Open scanner</Button>}
            <Switch label="All dates" checked={allDates} onChange={(e) => setAllDates(e.currentTarget.checked)} />
            {!allDates && <DatePickerInput size="xs" value={date} onChange={(v) => v && setDate(String(v).slice(0, 10))} valueFormat="D MMM YYYY" w={150} />}
          </Group>
        }
      />
      <Panel>
        <Tabs value={view} onChange={(v) => { setView(v ?? "ready"); setSelected(new Set()); }} px="md" pt={6}>
          <Tabs.List>
            {VIEWS.map((v) => (
              <Tabs.Tab key={v.value} value={v.value} rightSection={v.value === "ready" && q.data ? <Badge size="xs" variant="light">{q.data.counts.ready}</Badge> : v.value === "sorted" && q.data ? <Badge size="xs" variant="light" color="indigo">{q.data.counts.sorted}</Badge> : null}>
                {v.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>
        {selectable && (
          <Group p="md" justify="space-between">
            <Text size="sm" c="dimmed">{view === "ready" ? "Scan labels with the phone scanner, or mark sorted here if a label can't be scanned." : "Waiting for the courier to pick up."}</Text>
            <Group gap="xs">
              {view === "ready" && can("dispatch.manage") && (
                <Button size="xs" leftSection={<Truck size={14} />} disabled={!selected.size} loading={dispatch.isPending} onClick={() => dispatch.mutate()}>
                  Mark {selected.size || ""} sorted
                </Button>
              )}
              {view === "sorted" && can("dispatch.manage") && (
                <Button size="xs" variant="default" leftSection={<Undo2 size={14} />} disabled={!selected.size} onClick={() => setUndoOpen(true)}>Undo sort</Button>
              )}
            </Group>
          </Group>
        )}
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
          <EmptyState icon={<PackageCheck size={22} />} title="Nothing here" description={view === "exceptions" ? "No held, failed, cancelled or overdue parcels." : undefined} />
        ) : (
          <ScrollArea>
            <Table className="app-table" verticalSpacing={8} miw={980} mt={selectable ? 0 : "xs"}>
              <Table.Thead>
                <Table.Tr>
                  {selectable && <Table.Th w={40} pl="md"><Checkbox size="xs" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.orderId)))} aria-label="Select all" /></Table.Th>}
                  <Table.Th pl={selectable ? undefined : "md"}>Order</Table.Th>
                  <Table.Th>Tracking</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th ta="right">COD</Table.Th>
                  <Table.Th>Courier</Table.Th>
                  <Table.Th>Timeline</Table.Th>
                  <Table.Th pr="md">Shopify</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((o) => (
                  <Table.Tr key={o.orderId} data-selected={selected.has(o.orderId)} onClick={() => setOpenOrder(o.orderId)}>
                    {selectable && <Table.Td pl="md" onClick={(e) => e.stopPropagation()}><Checkbox size="xs" checked={selected.has(o.orderId)} onChange={() => toggle(o.orderId)} aria-label="Select" /></Table.Td>}
                    <Table.Td pl={selectable ? undefined : "md"}><Text size="sm" fw={600}>{o.orderName}</Text>{o.cancelledAt && <Badge size="xs" color="dark">Cancelled in Shopify</Badge>}</Table.Td>
                    <Table.Td><Text size="sm" className="mono">{o.trackingCode}</Text></Table.Td>
                    <Table.Td maw={220}><Text size="sm" lineClamp={1}>{o.customerName}</Text><Text size="xs" c="dimmed">{o.phone}{o.city ? ` · ${o.city}` : ""}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm">{money(o.codAmount)}</Text></Table.Td>
                    <Table.Td>
                      <Group gap={4}>{o.courierStatus && <SteadfastStatusBadge status={o.courierStatus} />}<StageBadge stage={o.courierStage} size="xs" /></Group>
                      {o.lastMessage && <Text size="xs" c="dimmed" lineClamp={1} maw={220}>{o.lastMessage}</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">Booked {dateShort(o.bookedAt)}</Text>
                      {o.printedAt && <Text size="xs" c="dimmed">Printed {dateShort(o.printedAt)}</Text>}
                      {o.sortedAt && <Text size="xs" c={view === "exceptions" && !o.dispatchedAt ? "red" : "dimmed"}>Sorted {ago(o.sortedAt)}{o.sortedBy ? ` by ${o.sortedBy}` : ""}</Text>}
                      {o.dispatchedAt && <Text size="xs" c="teal">Dispatched {dateShort(o.dispatchedAt)}</Text>}
                    </Table.Td>
                    <Table.Td pr="md"><FulfillmentBadge state={o.fulfillmentState} /></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Panel>
      <Modal opened={undoOpen} onClose={() => setUndoOpen(false)} title="Undo sort">
        <Stack>
          <Alert variant="light" color="gray">Use this when a parcel was scanned by mistake. The change is kept in the order history.</Alert>
          <Textarea label="Reason" required autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
          <Group justify="flex-end"><Button disabled={!reason.trim()} loading={undo.isPending} onClick={() => undo.mutate()}>Undo</Button></Group>
        </Stack>
      </Modal>
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={refresh} />
    </>
  );
}
