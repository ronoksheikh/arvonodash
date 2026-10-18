import { useState } from "react";
import { Alert, Badge, Button, Checkbox, Drawer, Group, ScrollArea, Select, Stack, Table, Tabs, Text, Textarea, Anchor } from "@mantine/core";
import { DateInput } from "@mantine/dates";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { api, notifyError, notifySuccess, patch, post, qs } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, Panel, ReturnStatusBadge, SteadfastStatusBadge } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { ago, day, money, titleCase } from "../format";
import { RETURN_FOLLOW_UPS, RETURN_STATUSES } from "../../shared/constants";
import type { ReturnRow } from "../types";

const TYPE_LABEL: Record<string, string> = { courier_return: "Failed delivery", partial_return: "Partial delivery", customer_return: "Customer return" };

export default function Returns() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>("open");
  const [editing, setEditing] = useState<ReturnRow | null>(null);
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["returns", status],
    queryFn: () => api<{ rows: ReturnRow[]; counts: Record<string, number> }>(`/returns${qs(status === "open" ? { open: 1 } : status === "all" ? {} : { status })}`),
  });
  const rows = q.data?.rows ?? [];
  const openCount = Object.entries(q.data?.counts ?? {}).filter(([k]) => k !== "closed").reduce((s, [, n]) => s + n, 0);

  return (
    <>
      <PageHeader title="Returns" description="Failed deliveries, partial deliveries and customer returns. Refunds and restocking always need staff confirmation." />
      <Panel>
        <Tabs value={status} onChange={(v) => setStatus(v ?? "open")} px="md" pt={6}>
          <Tabs.List>
            <Tabs.Tab value="open" rightSection={<Badge size="xs" variant="light">{openCount}</Badge>}>Open</Tabs.Tab>
            {Object.entries(RETURN_STATUSES).map(([k, s]) => (
              <Tabs.Tab key={k} value={k} rightSection={q.data?.counts[k] ? <Badge size="xs" variant="light" color="gray">{q.data.counts[k]}</Badge> : null}>{s.label}</Tabs.Tab>
            ))}
            <Tabs.Tab value="all">All</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? (
          <EmptyState title="No returns here" description="Returns are created automatically when Steadfast marks a parcel cancelled after pickup or partially delivered." />
        ) : (
          <ScrollArea>
            <Table className="app-table" verticalSpacing={10} miw={980} mt="xs">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th pl="md">Order</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Reason</Table.Th>
                  <Table.Th>Status</Table.Th>
                  <Table.Th>Follow-up</Table.Th>
                  <Table.Th>Confirmations</Table.Th>
                  <Table.Th pr="md">Created</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.id} onClick={() => setEditing(r)}>
                    <Table.Td pl="md">
                      <Anchor size="sm" fw={600} onClick={(e) => { e.stopPropagation(); setOpenOrder(r.orderId); }}>{r.orderName}</Anchor>
                      {r.trackingCode && <Text size="xs" c="dimmed" className="mono">{r.trackingCode}</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.customerName}</Text>
                      <Text size="xs" c="dimmed" className="mono">{r.phone}</Text>
                    </Table.Td>
                    <Table.Td><Badge size="sm" variant="outline" color="gray">{TYPE_LABEL[r.type] ?? r.type}</Badge></Table.Td>
                    <Table.Td maw={220}><Text size="sm" lineClamp={2}>{r.reason ?? "—"}</Text></Table.Td>
                    <Table.Td>
                      <ReturnStatusBadge status={r.status} />
                      {r.steadfastReturnStatus && <Text size="xs" c="dimmed">Steadfast: {r.steadfastReturnStatus}</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.followUpAction ? RETURN_FOLLOW_UPS[r.followUpAction as keyof typeof RETURN_FOLLOW_UPS] : "—"}</Text>
                      {r.followUpAt && <Text size="xs" c={new Date(r.followUpAt) < new Date() ? "red" : "dimmed"}>by {day(r.followUpAt)}</Text>}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge size="xs" color={r.restockConfirmed ? "teal" : "gray"} variant={r.restockConfirmed ? "light" : "outline"}>Restock</Badge>
                        <Badge size="xs" color={r.refundConfirmed ? "teal" : "gray"} variant={r.refundConfirmed ? "light" : "outline"}>Refund</Badge>
                      </Group>
                    </Table.Td>
                    <Table.Td pr="md"><Text size="xs" c="dimmed">{ago(r.createdAt)}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Panel>
      <ReturnEditor ret={editing} onClose={() => setEditing(null)} onSaved={() => qc.invalidateQueries({ queryKey: ["returns"] })} />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} />
    </>
  );
}

function ReturnEditor({ ret, onClose, onSaved }: { ret: ReturnRow | null; onClose: () => void; onSaved: () => void }) {
  const can = useCan();
  const [form, setForm] = useState<Partial<ReturnRow>>({});
  const current = { ...ret, ...form } as ReturnRow;
  const save = useMutation({
    mutationFn: () => patch(`/returns/${ret!.id}`, form),
    onSuccess: () => { notifySuccess("Return updated"); setForm({}); onSaved(); onClose(); },
    onError: (e) => notifyError(e),
  });
  const sync = useMutation({
    mutationFn: () => post<{ status: string }>(`/returns/${ret!.id}/sync`),
    onSuccess: (r) => { notifySuccess(`Steadfast status: ${r.status}`); onSaved(); },
    onError: (e) => notifyError(e),
  });
  const editable = can("returns.manage");
  return (
    <Drawer opened={ret !== null} onClose={() => { setForm({}); onClose(); }} position="right" size={480} title={<Text fw={600}>Return · {ret?.orderName}</Text>}>
      {ret && (
        <Stack>
          <Stack gap={4}>
            <KeyValue label="Type">{TYPE_LABEL[ret.type] ?? ret.type}</KeyValue>
            <KeyValue label="Order total">{money(ret.total)}</KeyValue>
            {ret.consignmentStatus && <KeyValue label="Courier status"><SteadfastStatusBadge status={ret.consignmentStatus} /></KeyValue>}
            {ret.steadfastReturnId && (
              <KeyValue label="Steadfast return">
                <Group gap={6}>
                  <Text size="sm">#{ret.steadfastReturnId} · {titleCase(ret.steadfastReturnStatus)}</Text>
                  <Button size="compact-xs" variant="subtle" leftSection={<RefreshCw size={12} />} loading={sync.isPending} onClick={() => sync.mutate()}>Sync</Button>
                </Group>
              </KeyValue>
            )}
            {ret.receivedAt && <KeyValue label="Received">{day(ret.receivedAt)}</KeyValue>}
          </Stack>
          <Select label="Status" data={Object.entries(RETURN_STATUSES).map(([value, s]) => ({ value, label: s.label }))} value={current.status} onChange={(v) => v && setForm({ ...form, status: v })} disabled={!editable} allowDeselect={false} />
          <Textarea label="Reason" autosize minRows={2} value={current.reason ?? ""} onChange={(e) => setForm({ ...form, reason: e.currentTarget.value })} disabled={!editable} />
          <Select label="Parcel condition" clearable data={[{ value: "good", label: "Good — resellable" }, { value: "damaged", label: "Damaged" }, { value: "missing_items", label: "Items missing" }]} value={current.condition} onChange={(v) => setForm({ ...form, condition: v })} disabled={!editable} />
          <Group grow>
            <Select label="Follow-up action" data={Object.entries(RETURN_FOLLOW_UPS).map(([value, label]) => ({ value, label }))} value={current.followUpAction} onChange={(v) => setForm({ ...form, followUpAction: v })} disabled={!editable} />
            <DateInput label="Follow up by" clearable value={current.followUpAt ? new Date(current.followUpAt) : null} onChange={(v) => setForm({ ...form, followUpAt: v ? new Date(v).toISOString() : null })} disabled={!editable} />
          </Group>
          <Textarea label="Notes" autosize minRows={3} value={current.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.currentTarget.value })} disabled={!editable} />
          <Alert variant="light" color="gray">
            <Text size="sm" mb="xs">Restocking and refunds are not performed automatically. Do them in Shopify, then confirm here.</Text>
            <Stack gap={6}>
              <Checkbox label="Restock confirmed (done in Shopify)" checked={current.restockConfirmed} onChange={(e) => setForm({ ...form, restockConfirmed: e.currentTarget.checked })} disabled={!editable} />
              <Checkbox label="Refund confirmed (done in Shopify)" checked={current.refundConfirmed} onChange={(e) => setForm({ ...form, refundConfirmed: e.currentTarget.checked })} disabled={!editable} />
            </Stack>
          </Alert>
          {editable && <Group justify="flex-end"><Button disabled={!Object.keys(form).length} loading={save.isPending} onClick={() => save.mutate()}>Save changes</Button></Group>}
        </Stack>
      )}
    </Drawer>
  );
}
