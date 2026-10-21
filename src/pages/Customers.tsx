import { useEffect, useState } from "react";
import { Badge, Button, Card, Drawer, Group, Rating, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Table, Text, TextInput, Textarea, Anchor } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, notifyError, notifySuccess, patch, post, qs } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, ReturnStatusBadge, StageBadge, TableFooter } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { ago, day, money, titleCase } from "../format";
import { NOTE_KINDS } from "../../shared/constants";
import type { Customer, History, Note, ReturnRow } from "../types";

type CustomerRow = Customer & { orders: number; delivered: number; returned: number; spent: number; lastOrderAt: string | null; successRate: number | null };
const FLAG_COLOR: Record<string, string> = { vip: "grape", risky: "orange", blocked: "red" };

export default function Customers() {
  const [search, setSearch] = useState("");
  const [debounced] = useDebouncedValue(search, 300);
  const [flag, setFlag] = useState<string | null>(null);
  const [sort, setSort] = useState("last");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["customers", debounced, flag, sort, page],
    queryFn: () => api<{ rows: CustomerRow[]; total: number }>(`/customers${qs({ search: debounced, flag, sort, page, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
  });
  const rows = q.data?.rows ?? [];
  return (
    <>
      <PageHeader title="Customers" description="Grouped by phone number — delivery history from your own courier records" />
      <Panel>
        <Group p="md" gap="sm">
          <TextInput placeholder="Name, phone or email" leftSection={<Search size={15} />} value={search} onChange={(e) => { setSearch(e.currentTarget.value); setPage(1); }} style={{ flex: "1 1 240px" }} />
          <Select placeholder="Any flag" clearable w={150} data={[{ value: "vip", label: "VIP" }, { value: "risky", label: "Risky" }, { value: "blocked", label: "Blocked" }, { value: "none", label: "No flag" }]} value={flag} onChange={(v) => { setFlag(v); setPage(1); }} />
          <SegmentedControl size="xs" value={sort} onChange={setSort} data={[{ value: "last", label: "Recent" }, { value: "orders", label: "Most orders" }, { value: "returned", label: "Most returns" }, { value: "spent", label: "Top spend" }]} />
        </Group>
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : rows.length === 0 ? <EmptyState title="No customers yet" /> : (
          <>
            <ScrollArea>
              <Table className="app-table" verticalSpacing={10} miw={860}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th pl="md">Customer</Table.Th>
                    <Table.Th>Phone</Table.Th>
                    <Table.Th ta="right">Orders</Table.Th>
                    <Table.Th ta="right">Delivered</Table.Th>
                    <Table.Th ta="right">Returned</Table.Th>
                    <Table.Th>Success rate</Table.Th>
                    <Table.Th ta="right">Delivered value</Table.Th>
                    <Table.Th pr="md">Last order</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((c) => (
                    <Table.Tr key={c.id} onClick={() => setOpen(c.id)}>
                      <Table.Td pl="md">
                        <Group gap={6}>
                          <Text size="sm" fw={500}>{c.name ?? "—"}</Text>
                          {c.flag && <Badge size="xs" color={FLAG_COLOR[c.flag]}>{c.flag}</Badge>}
                        </Group>
                        {c.email && <Text size="xs" c="dimmed">{c.email}</Text>}
                      </Table.Td>
                      <Table.Td><Text size="sm" className="mono">{c.phone}</Text></Table.Td>
                      <Table.Td ta="right">{c.orders}</Table.Td>
                      <Table.Td ta="right">{c.delivered}</Table.Td>
                      <Table.Td ta="right"><Text size="sm" c={c.returned ? "red" : undefined}>{c.returned}</Text></Table.Td>
                      <Table.Td>{c.successRate === null ? <Text size="sm" c="dimmed">—</Text> : <Badge size="sm" color={c.successRate >= 80 ? "teal" : c.successRate >= 50 ? "yellow" : "red"}>{c.successRate}%</Badge>}</Table.Td>
                      <Table.Td ta="right">{money(c.spent)}</Table.Td>
                      <Table.Td pr="md"><Text size="xs" c="dimmed">{ago(c.lastOrderAt)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
            <TableFooter page={page} pageSize={50} total={q.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Panel>
      <CustomerDrawer customerId={open} onClose={() => setOpen(null)} />
    </>
  );
}

type CustomerDetail = {
  customer: Customer;
  history: History;
  orders: { id: number; name: string; shopCreatedAt: string; total: number; courierStage: string; cancelledAt: string | null; fulfillmentState: string; city: string | null }[];
  notes: Note[];
  returns: ReturnRow[];
};

export function CustomerDrawer({ customerId, onClose }: { customerId: number | null; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const [order, setOrder] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState("internal");
  const [rating, setRating] = useState(0);
  const [profileNote, setProfileNote] = useState("");
  const q = useQuery({ queryKey: ["customer", customerId], queryFn: () => api<CustomerDetail>(`/customers/${customerId}`), enabled: customerId !== null });
  useEffect(() => setProfileNote(q.data?.customer.note ?? ""), [q.data?.customer.note]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["customer", customerId] });
    qc.invalidateQueries({ queryKey: ["customers"] });
  };
  const update = useMutation({ mutationFn: (body: Record<string, unknown>) => patch(`/customers/${customerId}`, body), onSuccess: () => { notifySuccess("Customer updated"); refresh(); }, onError: (e) => notifyError(e) });
  const addNote = useMutation({ mutationFn: () => post(`/customers/${customerId}/notes`, { kind, body: note, rating: rating || undefined }), onSuccess: () => { setNote(""); setRating(0); refresh(); }, onError: (e) => notifyError(e) });
  const d = q.data;
  return (
    <Drawer opened={customerId !== null} onClose={onClose} position="right" size={640} title={<Text fw={600}>{d?.customer.name ?? "Customer"}</Text>}>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : d ? (
        <Stack>
          <Group gap="xs">
            <Anchor href={`tel:${d.customer.phone}`} className="mono">{d.customer.phone}</Anchor>
            {d.customer.email && <Text size="sm" c="dimmed">· {d.customer.email}</Text>}
          </Group>
          <SimpleGrid cols={4} spacing="xs">
            {[
              ["Orders", d.history.orders],
              ["Delivered", d.history.delivered],
              ["Returned", d.history.returned],
              ["Success", d.history.successRate === null ? "—" : `${d.history.successRate}%`],
            ].map(([l, v]) => (
              <Card key={l as string} padding="sm"><Text size="xs" c="dimmed">{l}</Text><Text fw={600} fz="lg">{v}</Text></Card>
            ))}
          </SimpleGrid>
          <Group grow align="flex-end">
            <Select
              label="Customer flag"
              description="Blocked customers cannot be booked without override"
              clearable
              data={[{ value: "vip", label: "VIP" }, { value: "risky", label: "Risky" }, { value: "blocked", label: "Blocked" }]}
              value={d.customer.flag}
              onChange={(v) => update.mutate({ flag: v })}
              disabled={!can("orders.edit")}
            />
          </Group>
          <Textarea label="Profile note" autosize minRows={2} value={profileNote} onChange={(e) => setProfileNote(e.currentTarget.value)} onBlur={() => profileNote !== (d.customer.note ?? "") && update.mutate({ note: profileNote || null })} disabled={!can("orders.edit")} />

          <Text fw={600} size="sm" mt="sm">Orders</Text>
          <Card padding={0}>
            <Table className="app-table" verticalSpacing={8}>
              <Table.Tbody>
                {d.orders.map((o) => (
                  <Table.Tr key={o.id} onClick={() => setOrder(o.id)}>
                    <Table.Td pl="md"><Text size="sm" fw={500}>{o.name}</Text></Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{day(o.shopCreatedAt)}</Text></Table.Td>
                    <Table.Td>{o.cancelledAt ? <Badge size="xs" color="dark">Cancelled</Badge> : <StageBadge stage={o.courierStage} size="xs" />}</Table.Td>
                    <Table.Td ta="right" pr="md"><Text size="sm">{money(o.total)}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>

          {d.returns.length > 0 && (
            <>
              <Text fw={600} size="sm" mt="sm">Returns</Text>
              {d.returns.map((r) => (
                <Group key={r.id} justify="space-between">
                  <Text size="sm">{r.orderName} — {r.reason ?? titleCase(r.type)}</Text>
                  <ReturnStatusBadge status={r.status} />
                </Group>
              ))}
            </>
          )}

          <Text fw={600} size="sm" mt="sm">Notes, feedback & reviews</Text>
          {can("orders.edit") && (
            <Card padding="sm">
              <Stack gap="xs">
                <Select size="xs" value={kind} onChange={(v) => setKind(v ?? "internal")} allowDeselect={false} data={["internal", "call_log", "rider_feedback", "customer_review"].map((k) => ({ value: k, label: NOTE_KINDS[k as keyof typeof NOTE_KINDS] }))} />
                <Textarea size="sm" autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} placeholder="Add a note…" />
                {kind === "customer_review" && <Rating value={rating} onChange={setRating} />}
                <Group justify="flex-end"><Button size="xs" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Add</Button></Group>
              </Stack>
            </Card>
          )}
          {d.notes.map((n) => (
            <Card key={n.id} padding="sm">
              <Group gap={6} mb={4}>
                <Badge size="xs" variant="light">{NOTE_KINDS[n.kind as keyof typeof NOTE_KINDS] ?? n.kind}</Badge>
                {n.rating && <Rating value={n.rating} readOnly size="xs" />}
                <Text size="xs" c="dimmed">{n.userName ?? "System"} · {ago(n.createdAt)}{n.orderName ? ` · ${n.orderName}` : ""}</Text>
              </Group>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{n.body}</Text>
            </Card>
          ))}
        </Stack>
      ) : null}
      <OrderDrawer orderId={order} onClose={() => setOrder(null)} onChanged={refresh} />
    </Drawer>
  );
}
