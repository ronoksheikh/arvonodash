import { useState } from "react";
import { Badge, Button, Card, Group, Modal, ScrollArea, SegmentedControl, SimpleGrid, Stack, Table, Tabs, Text } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Wallet } from "lucide-react";
import { api, notifyError, notifySuccess, post } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui";
import { ago, day, money } from "../format";
import type { Consignment } from "../types";

type CodData = {
  days: number;
  summary: { bookedCount: number; booked: number; collected: number; pendingCollection: number; lost: number; settled: number; awaitingSettlement: number; charges: number };
  unsettled: Consignment[];
  payments: { id: string; amount: number | null; status: string | null; consignmentCount: number | null; paidAt: string | null; createdAt: string }[];
};

export default function Cod() {
  const [days, setDays] = useState("30");
  const can = useCan();
  const qc = useQueryClient();
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["cod", days], queryFn: () => api<CodData>(`/cod?days=${days}`) });
  const balance = useQuery({ queryKey: ["balance"], queryFn: () => api<{ balance: number }>("/cod/balance"), retry: false });
  const sync = useMutation({
    mutationFn: () => post<{ payments: number; linkedConsignments: number }>("/sync/payments"),
    onSuccess: (r) => { notifySuccess(`${r.payments} payments checked, ${r.linkedConsignments} consignments linked`); qc.invalidateQueries({ queryKey: ["cod"] }); },
    onError: (e) => notifyError(e, "Settlement sync failed"),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const s = d.summary;
  const cards = [
    { label: "COD booked", value: s.booked, hint: `${s.bookedCount} consignments` },
    { label: "Collected", value: s.collected, color: "teal" },
    { label: "With courier", value: s.pendingCollection, color: "indigo", hint: "Not yet delivered" },
    { label: "Awaiting settlement", value: s.awaitingSettlement, color: "orange", hint: "Delivered, not in a payment" },
    { label: "Settled", value: s.settled, color: "brand" },
    { label: "Lost to returns", value: s.lost, color: "red" },
  ];
  return (
    <>
      <PageHeader
        title="COD & Settlements"
        description="Cash collected by the courier and matched against their payouts"
        actions={
          <>
            <SegmentedControl size="xs" value={days} onChange={setDays} data={[{ value: "30", label: "30d" }, { value: "90", label: "90d" }, { value: "365", label: "1y" }]} />
            {can("sync.manage") && <Button variant="default" leftSection={<RefreshCw size={15} />} loading={sync.isPending} onClick={() => sync.mutate()}>Sync payments</Button>}
          </>
        }
      />
      <SimpleGrid cols={{ base: 2, md: 4, lg: 7 }} spacing="md">
        <Card padding="md">
          <Group gap={6}><Wallet size={14} /><Text size="xs" c="dimmed" fw={500}>Steadfast balance</Text></Group>
          <Text fz={24} fw={600} mt={4}>{balance.data ? money(balance.data.balance, true) : balance.error ? "—" : "…"}</Text>
          <Text size="xs" c="dimmed" mt={4}>{balance.error ? "Unavailable" : "Current payable"}</Text>
        </Card>
        {cards.map((c) => (
          <Card key={c.label} padding="md">
            <Text size="xs" c="dimmed" fw={500}>{c.label}</Text>
            <Text fz={24} fw={600} mt={4} c={c.color} style={{ fontVariantNumeric: "tabular-nums" }}>{money(c.value)}</Text>
            {c.hint && <Text size="xs" c="dimmed" mt={4}>{c.hint}</Text>}
          </Card>
        ))}
      </SimpleGrid>
      <Text size="xs" c="dimmed" mt="xs">Delivery charges in period: {money(s.charges)} (reported by the couriers)</Text>

      <Panel>
        <Tabs defaultValue="unsettled" mt="lg" px="md" pt={6}>
          <Tabs.List>
            <Tabs.Tab value="unsettled" rightSection={<Badge size="xs" variant="light" color="orange">{d.unsettled.length}</Badge>}>Delivered, not settled</Tabs.Tab>
            <Tabs.Tab value="payments" rightSection={<Badge size="xs" variant="light">{d.payments.length}</Badge>}>Steadfast payments</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="unsettled" mx="-md">
            {d.unsettled.length === 0 ? <EmptyState title="Everything delivered has been settled" /> : (
              <ScrollArea>
                <Table className="app-table" verticalSpacing={8} miw={700}>
                  <Table.Thead><Table.Tr><Table.Th pl="md">Order</Table.Th><Table.Th>Tracking</Table.Th><Table.Th ta="right">Collected</Table.Th><Table.Th ta="right">Charge</Table.Th><Table.Th pr="md">Delivered</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {d.unsettled.map((c) => (
                      <Table.Tr key={c.id} style={{ cursor: "default" }}>
                        <Table.Td pl="md"><Text size="sm" fw={500}>{c.orderName}</Text></Table.Td>
                        <Table.Td><Text size="sm" className="mono">{c.trackingCode}</Text></Table.Td>
                        <Table.Td ta="right">{money(c.collectedAmount ?? c.codAmount)}</Table.Td>
                        <Table.Td ta="right">{money(c.deliveryCharge)}</Table.Td>
                        <Table.Td pr="md"><Text size="xs" c={c.deliveredAt && Date.now() - Date.parse(c.deliveredAt) > 7 * 86_400_000 ? "red" : "dimmed"}>{ago(c.deliveredAt)}</Text></Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="payments" mx="-md">
            {d.payments.length === 0 ? <EmptyState title="No payments synced yet" description="Payments sync every 3 hours, or press Sync payments." /> : (
              <Table className="app-table" verticalSpacing={8}>
                <Table.Thead><Table.Tr><Table.Th pl="md">Payment</Table.Th><Table.Th ta="right">Amount</Table.Th><Table.Th>Status</Table.Th><Table.Th ta="right">Parcels</Table.Th><Table.Th pr="md">Date</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {d.payments.map((p) => (
                    <Table.Tr key={p.id} onClick={() => setPaymentId(p.id)}>
                      <Table.Td pl="md"><Text size="sm" fw={500} className="mono">#{p.id}</Text></Table.Td>
                      <Table.Td ta="right">{money(p.amount, true)}</Table.Td>
                      <Table.Td>{p.status ? <Badge size="sm">{p.status}</Badge> : "—"}</Table.Td>
                      <Table.Td ta="right">{p.consignmentCount ?? "—"}</Table.Td>
                      <Table.Td pr="md"><Text size="xs" c="dimmed">{day(p.paidAt ?? p.createdAt)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Tabs.Panel>
        </Tabs>
      </Panel>
      <PaymentModal id={paymentId} onClose={() => setPaymentId(null)} />
    </>
  );
}

function PaymentModal({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ["payment", id], queryFn: () => api<{ consignments: Consignment[] }>(`/cod/payments/${id}`), enabled: id !== null });
  return (
    <Modal opened={id !== null} onClose={onClose} title={`Payment #${id}`} size="lg">
      {q.isLoading ? <LoadingState /> : (
        <Stack>
          {(q.data?.consignments ?? []).length === 0 ? <Text size="sm" c="dimmed">No matching consignments in this dashboard.</Text> : (
            <Table className="app-table">
              <Table.Tbody>
                {q.data!.consignments.map((c) => (
                  <Table.Tr key={c.id} style={{ cursor: "default" }}>
                    <Table.Td>{c.orderName}</Table.Td>
                    <Table.Td className="mono">{c.trackingCode}</Table.Td>
                    <Table.Td ta="right">{money(c.collectedAmount)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
        </Stack>
      )}
    </Modal>
  );
}
