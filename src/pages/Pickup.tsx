import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Checkbox, Group, Modal, Progress, ScrollArea, SimpleGrid, Stack, Table, Text, TextInput, Title, UnstyledButton } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock, CheckCircle2, PackageX, ScanLine, Truck, Undo2 } from "lucide-react";
import { modals } from "@mantine/modals";
import { useNavigate } from "react-router";
import { api, notifyError, notifySuccess, post } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { dateShort, money } from "../format";

type Stage = "needs_booking" | "needs_label" | "needs_scan" | "ready" | "handed_over" | "not_collected" | "picked_up" | "pull_out" | "next_day";
type Parcel = {
  id: number;
  name: string;
  customerName: string | null;
  phone: string | null;
  city: string | null;
  codAmount: number;
  confirmedAt: string | null;
  autoBookAt: string | null;
  autoBookNote: string | null;
  consignmentId: string | null;
  handedOverAt: string | null;
  dispatchedAt: string | null;
  stage: Stage;
  carriedOver: boolean;
  shipBy: string | null;
  carryOverCount: number;
};
type Plan = {
  date: string;
  now: string;
  cutoffTime: string;
  cutoffAt: string;
  pickupTime: string;
  pickupAt: string;
  counts: { needsBooking: number; needsLabel: number; needsScan: number; ready: number; handedOver: number; notCollected: number; pickedUp: number; pullOut: number; nextDay: number; carriedOver: number; notReady: number; shipToday: number };
  parcels: Parcel[];
  pickups: { id: string; riderName: string | null; riderPhone: string | null; handedCount: number; leftBehindCount: number; readyCount: number; handedBy: string; createdAt: string; confirmedBySteadfast: number }[];
};

const STAGES: { key: Stage; label: string; color: string; hint: string }[] = [
  { key: "needs_booking", label: "Not booked", color: "orange", hint: "Confirmed, not sent to the courier yet" },
  { key: "needs_label", label: "Label not printed", color: "orange", hint: "Booked, label still to print" },
  { key: "needs_scan", label: "Not scanned", color: "orange", hint: "Printed, not scanned at packing" },
  { key: "ready", label: "Ready (scanned)", color: "teal", hint: "Scanned, waiting for the rider" },
  { key: "handed_over", label: "Handed to rider", color: "indigo", hint: "Rider took it; courier not confirmed yet" },
  { key: "picked_up", label: "Picked up", color: "green", hint: "Courier confirmed pickup today" },
];
const EXTRA: { key: Stage; label: string; color: string }[] = [
  { key: "pull_out", label: "Cancelled — pull out", color: "red" },
  { key: "not_collected", label: "Rider has it · not confirmed", color: "red" },
  { key: "next_day", label: "After cut-off · tomorrow", color: "gray" },
];
const STAGE_LABEL = Object.fromEntries([...STAGES, ...EXTRA].map((s) => [s.key, s]));

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}
function left(target: string, now: number) {
  const ms = Date.parse(target) - now;
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s).padStart(2, "0")}s`;
}
const hhmm12 = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};

export default function Pickup() {
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const now = useClock();
  const [filter, setFilter] = useState<Stage | "not_ready" | null>(null);
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [openOrder, setOpenOrder] = useState<number | null>(null);
  // Every 2 seconds, so scans made on another device (phone, second laptop) show up live.
  const q = useQuery({ queryKey: ["pickup-plan"], queryFn: () => api<Plan>("/ops/pickup"), refetchInterval: 2_000 });

  const undo = useMutation({
    mutationFn: (id: number) => post<{ reverted: number[] }>("/ops/pickup/undo-handover", { orderIds: [id], reason: "Rider did not take it" }),
    onSuccess: (r) => {
      notifySuccess(r.reverted.length ? "Back to ready — it goes with the next pickup" : "Nothing changed (the courier already has it)");
      qc.invalidateQueries({ queryKey: ["pickup-plan"] });
    },
    onError: (e) => notifyError(e),
  });
  const undoHandover = (r: Parcel) =>
    modals.openConfirmModal({
      title: `Undo handover of ${r.name}?`,
      children: <Text size="sm">Only if the parcel is still here. It goes back to "Ready (scanned)" and leaves with the next pickup.</Text>,
      labels: { confirm: "Undo handover", cancel: "Keep" },
      confirmProps: { color: "red" },
      onConfirm: () => undo.mutate(r.id),
    });

  if (q.isLoading) return <LoadingState />;
  // A failed 2-second refresh keeps showing the last plan; only a page with no data shows the error.
  if (!q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const c = p.counts;
  const cutoffLeft = left(p.cutoffAt, now);
  const pickupLeft = left(p.pickupAt, now);
  const done = c.ready + c.handedOver + c.pickedUp;
  const rows = p.parcels.filter((x) =>
    filter === null ? x.stage !== "next_day" : filter === "not_ready" ? ["needs_booking", "needs_label", "needs_scan"].includes(x.stage) : x.stage === filter,
  );
  const order: Stage[] = ["pull_out", "not_collected", "needs_booking", "needs_label", "needs_scan", "ready", "handed_over", "picked_up", "next_day"];
  rows.sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));

  return (
    <>
      <PageHeader
        title="Pickup today"
        description={`Orders confirmed before ${hhmm12(p.cutoffTime)} ship today. Anything not ready by pickup moves to tomorrow automatically and stays on top of the list until it leaves.`}
        actions={
          <Group gap="xs">
            {can("dispatch.manage") && <Button variant="default" leftSection={<ScanLine size={15} />} onClick={() => navigate("/scan")}>Open scanner</Button>}
            {can("dispatch.manage") && (
              <Button leftSection={<Truck size={15} />} disabled={!c.ready} onClick={() => setHandoverOpen(true)}>
                Courier arrived — hand over {c.ready || ""}
              </Button>
            )}
          </Group>
        }
      />

      <SimpleGrid cols={{ base: 1, sm: 3 }} mb="md">
        <Card padding="md">
          <Group gap={6}><AlarmClock size={15} /><Text size="xs" c="dimmed" fw={500}>Cut-off {hhmm12(p.cutoffTime)}</Text></Group>
          <Text fz={28} fw={700} mt={4} lh={1.1} style={{ fontVariantNumeric: "tabular-nums" }} c={cutoffLeft ? undefined : "dimmed"}>{cutoffLeft ?? "Passed"}</Text>
          <Text size="xs" c="dimmed" mt={6}>{cutoffLeft ? "left to confirm orders for today" : `New confirmations ship tomorrow (${c.nextDay} so far)`}</Text>
        </Card>
        <Card padding="md">
          <Group gap={6}><Truck size={15} /><Text size="xs" c="dimmed" fw={500}>Courier pickup ~{hhmm12(p.pickupTime)}</Text></Group>
          <Text fz={28} fw={700} mt={4} lh={1.1} style={{ fontVariantNumeric: "tabular-nums" }} c={pickupLeft ? undefined : "dimmed"}>{pickupLeft ?? (p.pickups.length ? "Collected" : "Due now")}</Text>
          <Text size="xs" c="dimmed" mt={6}>{p.pickups.length ? `${p.pickups.length} handover(s) today` : "No handover recorded yet"}</Text>
        </Card>
        <Card padding="md">
          <Text size="xs" c="dimmed" fw={500}>Ready for today</Text>
          <Text fz={28} fw={700} mt={4} lh={1.1} style={{ fontVariantNumeric: "tabular-nums" }}>{done} / {c.shipToday}</Text>
          <Progress value={c.shipToday ? (done / c.shipToday) * 100 : 100} color={c.notReady ? "orange" : "teal"} mt={10} size="sm" />
        </Card>
      </SimpleGrid>

      {c.notReady > 0 ? (
        <Alert color="orange" variant="light" mb="md" icon={<PackageX size={18} />} title={`${c.notReady} parcel(s) for today are not ready yet`}>
          {[c.needsBooking && `${c.needsBooking} not booked`, c.needsLabel && `${c.needsLabel} label not printed`, c.needsScan && `${c.needsScan} not scanned`].filter(Boolean).join(" · ")}
          {c.carriedOver > 0 && ` · ${c.carriedOver} carried over from earlier days`}. They will be left behind unless they are scanned before the rider leaves.{" "}
          <UnstyledButton onClick={() => setFilter("not_ready")} style={{ textDecoration: "underline", fontSize: 14 }}>Show them</UnstyledButton>
        </Alert>
      ) : c.shipToday > 0 ? (
        <Alert color="teal" variant="light" mb="md" icon={<CheckCircle2 size={18} />} title="Everything for today is scanned">
          Nothing will be left behind.
        </Alert>
      ) : null}
      {c.notCollected > 0 && (
        <Alert color="red" variant="light" mb="md" icon={<Truck size={18} />} title={`${c.notCollected} parcel(s) were handed to a rider on an earlier day, but the courier still hasn't confirmed pickup`}>
          Call the rider. If a parcel is actually still here, open it below and press "Undo handover" so it goes with the next pickup.{" "}
          <UnstyledButton onClick={() => setFilter("not_collected")} style={{ textDecoration: "underline", fontSize: 14 }}>Show them</UnstyledButton>
        </Alert>
      )}
      {c.pullOut > 0 && (
        <Alert color="red" variant="filled" mb="md" title={`${c.pullOut} scanned parcel(s) were cancelled in Shopify — take them off the pickup pile`}>
          <UnstyledButton c="white" onClick={() => setFilter("pull_out")} style={{ textDecoration: "underline", fontSize: 14 }}>Show them</UnstyledButton>
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }} mb="md" spacing="xs">
        {STAGES.map((s) => {
          const n = p.parcels.filter((x) => x.stage === s.key).length;
          const active = filter === s.key;
          return (
            <UnstyledButton key={s.key} onClick={() => setFilter(active ? null : s.key)}>
              <Card padding="sm" style={{ borderColor: active ? `var(--mantine-color-${s.color}-6)` : undefined, borderWidth: active ? 2 : undefined }}>
                <Group gap={6} wrap="nowrap"><Badge size="xs" circle color={s.color}> </Badge><Text size="xs" fw={600}>{s.label}</Text></Group>
                <Text fz={24} fw={700} mt={2} style={{ fontVariantNumeric: "tabular-nums" }}>{n}</Text>
                <Text size="xs" c="dimmed" lineClamp={1}>{s.hint}</Text>
              </Card>
            </UnstyledButton>
          );
        })}
      </SimpleGrid>

      <Panel>
        <Group justify="space-between" p="md" pb="xs">
          <Text fw={600}>{filter === null ? "All parcels for today" : filter === "not_ready" ? "Not ready" : STAGE_LABEL[filter].label}</Text>
          <Group gap="xs">
            {c.nextDay > 0 && <Button size="compact-xs" variant={filter === "next_day" ? "filled" : "default"} onClick={() => setFilter(filter === "next_day" ? null : "next_day")}>Tomorrow ({c.nextDay})</Button>}
            {filter !== null && <Button size="compact-xs" variant="subtle" onClick={() => setFilter(null)}>Show all</Button>}
          </Group>
        </Group>
        {rows.length === 0 ? (
          <EmptyState title="Nothing here" description={c.shipToday ? undefined : "No confirmed orders waiting to ship."} />
        ) : (
          <ScrollArea>
            <Table className="app-table" verticalSpacing={8} miw={820}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th pl="md">Order</Table.Th>
                  <Table.Th>Customer</Table.Th>
                  <Table.Th ta="right">COD</Table.Th>
                  <Table.Th>Where it is</Table.Th>
                  <Table.Th pr="md">Confirmed</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((r) => (
                  <Table.Tr key={r.id} onClick={() => setOpenOrder(r.id)}>
                    <Table.Td pl="md"><Text size="sm" fw={600}>{r.name}</Text>{r.consignmentId && <Text size="xs" c="dimmed" className="mono">CID {r.consignmentId}</Text>}</Table.Td>
                    <Table.Td maw={240}><Text size="sm" lineClamp={1}>{r.customerName}</Text><Text size="xs" c="dimmed">{r.phone}{r.city ? ` · ${r.city}` : ""}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm">{money(r.codAmount)}</Text></Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge size="sm" variant="light" color={STAGE_LABEL[r.stage].color}>{STAGE_LABEL[r.stage].label}</Badge>
                        {r.carriedOver && (
                          <Badge size="sm" variant="outline" color="red">
                            {r.carryOverCount > 0 ? `Late ${r.carryOverCount} day${r.carryOverCount > 1 ? "s" : ""}` : "From earlier"}
                          </Badge>
                        )}
                      </Group>
                      {r.stage === "needs_booking" && (r.autoBookAt ? <Text size="xs" c="dimmed">Auto-books {dateShort(r.autoBookAt)}</Text> : r.autoBookNote ? <Text size="xs" c="orange" lineClamp={1}>{r.autoBookNote}</Text> : <Text size="xs" c="dimmed">Book it from Orders</Text>)}
                      {r.handedOverAt && (
                        <Group gap={6}>
                          <Text size="xs" c="dimmed">Handed over {dateShort(r.handedOverAt)}</Text>
                          {can("dispatch.manage") && (r.stage === "handed_over" || r.stage === "not_collected") && (
                            <Button size="compact-xs" variant="subtle" color="red" leftSection={<Undo2 size={12} />} onClick={(e) => { e.stopPropagation(); undoHandover(r); }}>
                              Undo handover
                            </Button>
                          )}
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td pr="md"><Text size="xs" c="dimmed">{dateShort(r.confirmedAt)}</Text></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea>
        )}
      </Panel>

      {p.pickups.length > 0 && (
        <Panel>
          <Text fw={600} p="md" pb="xs">Today's handovers</Text>
          <Table className="app-table" verticalSpacing={8}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th pl="md">Time</Table.Th>
                <Table.Th>Rider</Table.Th>
                <Table.Th ta="right">Handed over</Table.Th>
                <Table.Th ta="right">Left behind</Table.Th>
                <Table.Th pr="md">Courier confirmed</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {p.pickups.map((h) => (
                <Table.Tr key={h.id}>
                  <Table.Td pl="md"><Text size="sm">{dateShort(h.createdAt)}</Text><Text size="xs" c="dimmed">by {h.handedBy}</Text></Table.Td>
                  <Table.Td><Text size="sm">{h.riderName ?? "—"}</Text>{h.riderPhone && <Text size="xs" component="a" href={`tel:${h.riderPhone}`} c="blue">{h.riderPhone}</Text>}</Table.Td>
                  <Table.Td ta="right"><Text size="sm" fw={600}>{h.handedCount}</Text></Table.Td>
                  <Table.Td ta="right"><Text size="sm" c={h.leftBehindCount ? "orange" : undefined}>{h.leftBehindCount}</Text></Table.Td>
                  <Table.Td pr="md">
                    <Group gap={8} wrap="nowrap">
                      <Progress value={(h.confirmedBySteadfast / Math.max(1, h.handedCount)) * 100} w={90} size="sm" color="green" />
                      <Text size="sm">{h.confirmedBySteadfast} / {h.handedCount}</Text>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Panel>
      )}

      <HandoverModal plan={p} opened={handoverOpen} onClose={() => setHandoverOpen(false)} onDone={() => qc.invalidateQueries({ queryKey: ["pickup-plan"] })} />
      <OrderDrawer orderId={openOrder} onClose={() => setOpenOrder(null)} onChanged={() => q.refetch()} />
    </>
  );
}

const RIDER_KEY = "arvono.pickup.rider";

function HandoverModal({ plan, opened, onClose, onDone }: { plan: Plan; opened: boolean; onClose: () => void; onDone: () => void }) {
  const ready = useMemo(() => plan.parcels.filter((x) => x.stage === "ready"), [plan]);
  const notReady = plan.parcels.filter((x) => ["needs_booking", "needs_label", "needs_scan"].includes(x.stage));
  const pullOut = plan.parcels.filter((x) => x.stage === "pull_out");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [rider, setRider] = useState({ name: "", phone: "" });

  useEffect(() => {
    if (!opened) return;
    setSelected(new Set(ready.map((r) => r.id)));
    try {
      setRider(JSON.parse(localStorage.getItem(RIDER_KEY) ?? "null") ?? { name: "", phone: "" });
    } catch {
      // no saved rider
    }
    // Only when the dialog opens; the plan refreshes in the background meanwhile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened]);

  const m = useMutation({
    mutationFn: () => post<{ handed: number; skipped: number[]; leftBehind: number }>("/ops/pickup/handover", { orderIds: [...selected], riderName: rider.name, riderPhone: rider.phone }),
    onSuccess: (r) => {
      try {
        localStorage.setItem(RIDER_KEY, JSON.stringify(rider));
      } catch {
        // ignore
      }
      notifySuccess(`${r.handed} parcel(s) handed to the rider${r.skipped.length ? ` · ${r.skipped.length} skipped (changed meanwhile)` : ""}`, "Handover recorded");
      onDone();
      onClose();
    },
    onError: (e) => notifyError(e),
  });

  const all = ready.length > 0 && ready.every((r) => selected.has(r.id));
  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={<Title order={4}>Courier handover</Title>}>
      <Stack>
        <Group grow>
          <TextInput label="Rider name" value={rider.name} onChange={(e) => setRider({ ...rider, name: e.currentTarget.value })} />
          <TextInput label="Rider phone" value={rider.phone} inputMode="tel" onChange={(e) => setRider({ ...rider, phone: e.currentTarget.value })} />
        </Group>
        {pullOut.length > 0 && (
          <Alert color="red" variant="filled" title={`Do NOT give these ${pullOut.length} — cancelled in Shopify`}>
            {pullOut.map((x) => x.name).join(", ")}
          </Alert>
        )}
        {notReady.length > 0 && (
          <Alert color="orange" variant="light" title={`${notReady.length} parcel(s) for today will be left behind (not scanned)`}>
            <Text size="sm">{notReady.slice(0, 30).map((x) => x.name).join(", ")}{notReady.length > 30 ? ` +${notReady.length - 30} more` : ""}</Text>
            <Text size="xs" c="dimmed" mt={4}>Scan them now if they are packed. Only scanned parcels can be handed over.</Text>
          </Alert>
        )}
        <Group justify="space-between">
          <Checkbox label={`All scanned parcels (${ready.length})`} checked={all} indeterminate={!all && selected.size > 0} onChange={() => setSelected(all ? new Set() : new Set(ready.map((r) => r.id)))} />
          <Text size="sm" c="dimmed">Untick anything the rider is not taking</Text>
        </Group>
        <ScrollArea.Autosize mah={320}>
          <Stack gap={4}>
            {ready.map((r) => (
              <Checkbox
                key={r.id}
                checked={selected.has(r.id)}
                onChange={() => {
                  const n = new Set(selected);
                  n.has(r.id) ? n.delete(r.id) : n.add(r.id);
                  setSelected(n);
                }}
                label={<Text size="sm">{r.name} · {r.customerName} · {money(r.codAmount)} <Text span size="xs" c="dimmed" className="mono">CID {r.consignmentId}</Text></Text>}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button leftSection={<Truck size={15} />} disabled={!selected.size} loading={m.isPending} onClick={() => m.mutate()}>Hand over {selected.size} parcel(s)</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
