import { useState } from "react";
import { Alert, Badge, Button, Card, Chip, Group, Modal, SegmentedControl, SimpleGrid, Stack, Switch, Text, Textarea } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageSquarePlus, Phone, RefreshCw } from "lucide-react";
import { api, notifyError, notifySuccess, post } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeader, SteadfastStatusBadge } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { ago, dateShort, money } from "../format";

type Reason = "exceptional" | "not_received" | "waiting_pickup" | "on_hold" | "unconfirmed" | "no_update" | "slow_transit";
type StuckParcel = {
  rowId: number;
  orderId: number;
  orderName: string;
  customerName: string;
  phone: string;
  city: string | null;
  address: string;
  codAmount: number;
  consignmentId: string | null;
  trackingCode: string | null;
  status: string;
  courier: string;
  lastMessage: string | null;
  lastUpdate: string | null;
  pickedUpAt: string | null;
  handedOverAt: string | null;
  transitDays: number | null;
  expectedDays: number;
  reasons: { code: Reason; text: string }[];
  riderPhones: string[];
  pickupRiderName: string | null;
  pickupRiderPhone: string | null;
  followUpNote: string | null;
  followUpAt: string | null;
  followUpBy: string | null;
  snoozed: boolean;
};

const REASONS: Record<Reason, { label: string; color: string }> = {
  exceptional: { label: "Lost / damaged", color: "red" },
  unconfirmed: { label: "Not confirmed", color: "cyan" },
  not_received: { label: "Rider didn't confirm", color: "red" },
  on_hold: { label: "On hold", color: "orange" },
  no_update: { label: "No update", color: "orange" },
  slow_transit: { label: "Slower than normal", color: "yellow" },
  waiting_pickup: { label: "Not collected", color: "gray" },
};
const QUICK_NOTES = [
  "Customer will receive tomorrow",
  "Customer not reachable",
  "Customer refused — will return",
  "Rider says out for delivery",
  "Rider not reachable",
  "Asked courier support",
];

export default function Stuck() {
  const can = useCan();
  const qc = useQueryClient();
  const [reason, setReason] = useState<Reason | "all">("all");
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [logFor, setLogFor] = useState<StuckParcel | null>(null);
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["stuck", showSnoozed],
    queryFn: () => api<{ parcels: StuckParcel[]; snoozed: number }>(`/ops/stuck${showSnoozed ? "?all=1" : ""}`),
    refetchInterval: 60_000,
  });
  const refresh = useMutation({
    mutationFn: (rowId: number) => post("/consignments/refresh", { ids: [rowId] }),
    onSuccess: () => {
      notifySuccess("Latest status fetched from the courier");
      qc.invalidateQueries({ queryKey: ["stuck"] });
    },
    onError: (e) => notifyError(e),
  });

  const parcels = q.data?.parcels ?? [];
  const count = (r: Reason) => parcels.filter((p) => p.reasons.some((x) => x.code === r)).length;
  const rows = reason === "all" ? parcels : parcels.filter((p) => p.reasons.some((x) => x.code === reason));

  return (
    <>
      <PageHeader
        title="Stuck parcels"
        description="Parcels that need a call: the rider took them but the courier never confirmed, on hold, no courier update for days, or slower than usual for the district. Usual delivery times are learned from your own past deliveries."
        actions={<Switch label={`Show snoozed${q.data?.snoozed ? ` (${q.data.snoozed})` : ""}`} checked={showSnoozed} onChange={(e) => setShowSnoozed(e.currentTarget.checked)} />}
      />
      <SegmentedControl
        mb="md"
        value={reason}
        onChange={(v) => setReason(v as Reason | "all")}
        data={[
          { value: "all", label: `All (${parcels.length})` },
          ...(Object.keys(REASONS) as Reason[]).map((r) => ({ value: r, label: `${REASONS[r].label} (${count(r)})` })),
        ]}
        style={{ maxWidth: "100%", overflowX: "auto" }}
      />
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<CheckCircle2 size={22} />} title="No stuck parcels" description="Every parcel with the courier is moving normally." />
      ) : (
        <SimpleGrid cols={{ base: 1, lg: 2 }}>
          {rows.map((p) => (
            <Card key={p.rowId} padding="md" style={{ opacity: p.snoozed ? 0.6 : 1 }}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Group gap={6}>
                    <Text fw={700} style={{ cursor: "pointer" }} onClick={() => setOpenOrder(p.orderId)}>{p.orderName}</Text>
                    <SteadfastStatusBadge status={p.status} courier={p.courier} />
                    {p.snoozed && <Badge size="xs" color="gray">Snoozed</Badge>}
                  </Group>
                  <Text size="xs" c="dimmed" className="mono">CID {p.consignmentId} · {p.trackingCode}</Text>
                </div>
                <Text fw={700}>{money(p.codAmount)}</Text>
              </Group>

              <Stack gap={4} mt="sm">
                {p.reasons.map((r) => (
                  <Group key={r.code} gap={6} wrap="nowrap" align="flex-start">
                    <Badge size="sm" variant="light" color={REASONS[r.code].color} style={{ flexShrink: 0 }}>{REASONS[r.code].label}</Badge>
                    <Text size="sm">{r.text}</Text>
                  </Group>
                ))}
              </Stack>

              <Text size="sm" mt="sm" fw={500}>{p.customerName}</Text>
              <Text size="xs" c="dimmed" lineClamp={2}>{p.address}</Text>
              <Text size="xs" c="dimmed" mt={4}>
                {p.lastMessage ? `Last update: "${p.lastMessage}" · ` : ""}{p.lastUpdate ? ago(p.lastUpdate) : "no update yet"}
                {p.pickedUpAt ? ` · picked up ${dateShort(p.pickedUpAt)}` : p.handedOverAt ? ` · handed over ${dateShort(p.handedOverAt)}` : ""}
              </Text>
              {p.followUpNote && (
                <Alert variant="light" color="blue" mt="sm" p="xs">
                  <Text size="xs"><b>{p.followUpBy}</b> {ago(p.followUpAt)}: {p.followUpNote}</Text>
                </Alert>
              )}

              <Group gap="xs" mt="md">
                <Button size="xs" component="a" href={`tel:${p.phone}`} leftSection={<Phone size={14} />}>Call customer</Button>
                {p.pickupRiderPhone && !p.riderPhones.includes(p.pickupRiderPhone.slice(-11)) && (
                  <Button size="xs" variant="light" color="indigo" component="a" href={`tel:${p.pickupRiderPhone}`} leftSection={<Phone size={14} />}>
                    Call pickup rider{p.pickupRiderName ? ` (${p.pickupRiderName})` : ""}
                  </Button>
                )}
                {p.riderPhones.map((ph) => (
                  <Button key={ph} size="xs" variant="light" component="a" href={`tel:${ph}`} leftSection={<Phone size={14} />}>Call delivery rider {ph}</Button>
                ))}
                {(can("orders.call") || can("courier.manage")) && (
                  <Button size="xs" variant="default" leftSection={<MessageSquarePlus size={14} />} onClick={() => setLogFor(p)}>Log call</Button>
                )}
                {can("courier.manage") && (
                  <Button size="xs" variant="subtle" leftSection={<RefreshCw size={14} />} loading={refresh.isPending && refresh.variables === p.rowId} onClick={() => refresh.mutate(p.rowId)}>
                    Refresh
                  </Button>
                )}
              </Group>
              {p.riderPhones.length === 0 && !p.pickupRiderPhone && <Text size="xs" c="dimmed" mt={6}>No rider number yet: the courier's updates don't include one and no rider phone was entered at handover.</Text>}
            </Card>
          ))}
        </SimpleGrid>
      )}
      <FollowUpModal parcel={logFor} onClose={() => setLogFor(null)} onSaved={() => qc.invalidateQueries({ queryKey: ["stuck"] })} />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={() => q.refetch()} />
    </>
  );
}

function FollowUpModal({ parcel, onClose, onSaved }: { parcel: StuckParcel | null; onClose: () => void; onSaved: () => void }) {
  const [note, setNote] = useState("");
  const [snooze, setSnooze] = useState("1");
  const m = useMutation({
    mutationFn: () => post(`/ops/stuck/${parcel!.rowId}/follow-up`, { note, snoozeDays: Number(snooze) }),
    onSuccess: () => {
      notifySuccess(Number(snooze) ? `Saved — hidden for ${snooze} day(s) unless it changes` : "Saved");
      setNote("");
      onSaved();
      onClose();
    },
    onError: (e) => notifyError(e),
  });
  return (
    <Modal opened={Boolean(parcel)} onClose={onClose} title={parcel ? `Log call · ${parcel.orderName}` : ""}>
      <Stack>
        <Chip.Group>
          <Group gap={6}>
            {QUICK_NOTES.map((t) => (
              <Chip key={t} size="xs" checked={note === t} onChange={() => setNote(t)}>{t}</Chip>
            ))}
          </Group>
        </Chip.Group>
        <Textarea label="What happened" autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <div>
          <Text size="sm" fw={500} mb={4}>Hide it for</Text>
          <SegmentedControl value={snooze} onChange={setSnooze} data={[{ value: "0", label: "Keep showing" }, { value: "1", label: "1 day" }, { value: "2", label: "2 days" }, { value: "3", label: "3 days" }]} />
        </div>
        <Text size="xs" c="dimmed">The note is also added to the order's notes.</Text>
        <Group justify="flex-end">
          <Button disabled={!note.trim()} loading={m.isPending} onClick={() => m.mutate()}>Save</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
