import { useState } from "react";
import { Anchor, Badge, Button, Checkbox, Group, ScrollArea, Select, Switch, Table, Text, TextInput } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search } from "lucide-react";
import { api, notifyError, notifySuccess, post, qs } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, FulfillmentBadge, LoadingState, PageHeader, Panel, StageBadge, SteadfastStatusBadge, TableFooter } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { ago, dateShort, money } from "../format";
import { COURIERS, type CourierId } from "../../shared/couriers";
import { COURIER_STAGES } from "../../shared/constants";
import type { Consignment } from "../types";

export default function Consignments() {
  const can = useCan();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [stage, setStage] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [stale, setStale] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openOrder, setOpenOrder] = useState<number | null>(null);

  const filters = { search: debounced, stage, active: active ? 1 : null, stale: stale ? 1 : null, page };
  const q = useQuery({
    queryKey: ["consignments", filters],
    queryFn: () => api<{ rows: Consignment[]; total: number }>(`/consignments${qs({ ...filters, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const refresh = useMutation({
    mutationFn: (ids: number[]) => post<{ checked: number; changed: number; errors: number }>("/consignments/refresh", { ids }),
    onSuccess: (r) => {
      notifySuccess(`${r.checked} checked, ${r.changed} updated${r.errors ? `, ${r.errors} errors` : ""}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ["consignments"] });
    },
    onError: (e) => notifyError(e),
  });
  const rows = q.data?.rows ?? [];
  const toggle = (id: number) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };

  return (
    <>
      <PageHeader
        title="Consignments"
        description="Every courier parcel (Steadfast and Carrybee) with live status from webhooks, polled as a fallback"
        actions={can("courier.manage") && (
          <Button variant="default" leftSection={<RefreshCw size={15} />} disabled={!selected.size} loading={refresh.isPending} onClick={() => refresh.mutate([...selected])}>
            Refresh selected{selected.size ? ` (${selected.size})` : ""}
          </Button>
        )}
      />
      <Panel>
        <Group p="md" gap="sm">
          <TextInput placeholder="Tracking code, consignment ID, invoice, phone…" leftSection={<Search size={15} />} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }} style={{ flex: "1 1 260px" }} />
          <Select placeholder="Any stage" clearable data={Object.entries(COURIER_STAGES).filter(([k]) => k !== "unbooked").map(([value, s]) => ({ value, label: s.label }))} value={stage} onChange={(v) => { setStage(v); setPage(1); }} w={190} />
          <Switch label="Active only" checked={active} onChange={(e) => { setActive(e.currentTarget.checked); setPage(1); }} />
          <Switch label="Stuck > 5 days" checked={stale} onChange={(e) => { setStale(e.currentTarget.checked); setPage(1); }} />
        </Group>
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="No consignments" description="Book orders from the Orders page to create courier parcels." />
        ) : (
          <>
            <ScrollArea>
              <Table className="app-table" verticalSpacing={10} miw={1050}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={40} pl="md"><Checkbox size="xs" checked={rows.length > 0 && rows.every((r) => selected.has(r.id))} onChange={() => setSelected(rows.every((r) => selected.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /></Table.Th>
                    <Table.Th>Order</Table.Th>
                    <Table.Th>Tracking</Table.Th>
                    <Table.Th>Recipient</Table.Th>
                    <Table.Th ta="right">COD</Table.Th>
                    <Table.Th>Courier status</Table.Th>
                    <Table.Th>Stage</Table.Th>
                    <Table.Th>Fulfillment</Table.Th>
                    <Table.Th pr="md">Updated</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((c) => (
                    <Table.Tr key={c.id} data-selected={selected.has(c.id)} onClick={() => setOpenOrder(c.orderId)}>
                      <Table.Td pl="md" onClick={(e) => e.stopPropagation()}><Checkbox size="xs" checked={selected.has(c.id)} onChange={() => toggle(c.id)} aria-label="Select" /></Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600}>{c.orderName}</Text>
                        <Text size="xs" c="dimmed">{c.invoice}</Text>
                      </Table.Td>
                      <Table.Td onClick={(e) => e.stopPropagation()}>
                        {c.trackingCode ? <Anchor href={c.trackingUrl ?? undefined} target="_blank" className="mono" size="sm">{c.trackingCode}</Anchor> : <Text size="sm" c="dimmed">—</Text>}
                        {c.consignmentId && <Text size="xs" c="dimmed" className="mono">{c.consignmentId}</Text>}
                      </Table.Td>
                      <Table.Td maw={220}>
                        <Text size="sm" lineClamp={1}>{c.recipientName}</Text>
                        <Text size="xs" c="dimmed" className="mono">{c.recipientPhone}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={500}>{money(c.codAmount)}</Text>
                        {c.collectedAmount !== null && c.collectedAmount !== c.codAmount && <Text size="xs" c="dimmed">got {money(c.collectedAmount)}</Text>}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap"><Badge size="xs" variant="outline" color={c.courier === "carrybee" ? "orange" : "gray"}>{COURIERS[c.courier as CourierId]?.label ?? c.courier}</Badge><SteadfastStatusBadge status={c.status} courier={c.courier} /></Group>
                        {c.lastMessage && <Text size="xs" c="dimmed" lineClamp={1} maw={220} mt={2}>{c.lastMessage}</Text>}
                      </Table.Td>
                      <Table.Td>
                        <StageBadge stage={c.stage} />
                        {c.superseded && <Badge size="xs" color="gray" ml={4}>old</Badge>}
                        {c.orderCancelledAt && !c.isFinal && <Badge size="xs" color="red" ml={4}>order cancelled</Badge>}
                      </Table.Td>
                      <Table.Td><FulfillmentBadge state={c.fulfillmentState ?? "none"} /></Table.Td>
                      <Table.Td pr="md">
                        <Text size="xs">{ago(c.lastStatusAt)}</Text>
                        <Text size="xs" c="dimmed">booked {dateShort(c.createdAt)}</Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
            <TableFooter page={page} pageSize={50} total={q.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Panel>
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={() => qc.invalidateQueries({ queryKey: ["consignments"] })} />
    </>
  );
}
