import { useEffect, useState } from "react";
import {
  ActionIcon, Alert, Anchor, Badge, Button, Card, Divider, Drawer, Group, Menu, NumberInput, Rating, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Table, Tabs, TagsInput, Text, Textarea, TextInput, Timeline, Title, Tooltip, Checkbox, Modal, CopyButton,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modals } from "@mantine/modals";
import {
  AlertTriangle, Ban, ExternalLink, Timer, MapPin, MoreVertical, Package, Phone, RefreshCw, Send, Trash2, Truck, User, RotateCcw, CheckCircle2, ShieldCheck, Printer, MessageSquarePlus, PackageCheck, Link2, Check, XCircle,
} from "lucide-react";
import { api, del, notifyError, notifySuccess, patch, post, put } from "../api";
import { useCan } from "../auth";
import { useBookingCourier } from "../courier";
import { useCountdown, Copyable, CustomStatusBadge, DispatchBadge, ErrorState, FulfillmentBadge, KeyValue, LabelBadge, LoadingState, RiskBadge, SteadfastStatusBadge, useStatuses, ReturnStatusBadge } from "./ui";
import { CallingPanel } from "./Calling";
import { RiskBanner, RiskTab } from "./Risk";
import { OrderProgress } from "./Progress";
import { RISK_LEVELS } from "../../shared/risk";
import { JourneyTab } from "./Journey";
import { SmsTab } from "./Sms";
import { SourceCard } from "./Source";
import { PARTIAL_OUTCOME_LABEL } from "../../shared/delivery";
import { CARRYBEE_STATUSES, COURIERS, courierName, type CourierId } from "../../shared/couriers";
import { ago, dateTime, money, titleCase } from "../format";
import { DISPATCH_EVENTS, NOTE_KINDS, RISK_FLAGS, STEADFAST_STATUSES } from "../../shared/constants";
import type { Booking, OrderDetail } from "../types";

export function OrderDrawer({ orderId, onClose, onChanged }: { orderId: number | null; onClose: () => void; onChanged?: () => void }) {
  const [tab, setTab] = useState<string | null>("overview");
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["order", orderId],
    queryFn: () => api<OrderDetail>(`/orders/${orderId}`),
    enabled: orderId !== null,
    refetchInterval: 30_000,
  });
  useEffect(() => setTab("overview"), [orderId]);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["order", orderId] });
    onChanged?.();
  };
  const d = q.data;

  return (
    <Drawer
      opened={orderId !== null}
      onClose={onClose}
      position="right"
      size={760}
      padding={0}
      withCloseButton={false}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      {q.isLoading ? (
        <LoadingState />
      ) : q.error ? (
        <div style={{ padding: 20 }}><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>
      ) : d ? (
        <>
          <DrawerHeader d={d} onClose={onClose} refresh={refresh} openRisk={() => setTab("risk")} />
          <Tabs value={tab} onChange={setTab} px="lg" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              <Tabs.Tab value="risk" rightSection={<Badge size="xs" variant={d.risk.level === "high" ? "filled" : "light"} color={RISK_LEVELS[d.risk.level].color}>{d.risk.score}</Badge>}>Risk</Tabs.Tab>
              <Tabs.Tab value="booking">Booking</Tabs.Tab>
              <Tabs.Tab value="courier" rightSection={d.consignments.length ? <Badge size="xs" variant="light">{d.consignments.length}</Badge> : null}>Courier</Tabs.Tab>
              <Tabs.Tab value="notes" rightSection={d.notes.length ? <Badge size="xs" variant="light">{d.notes.length}</Badge> : null}>Notes</Tabs.Tab>
              <Tabs.Tab value="sms" rightSection={d.sms.length ? <Badge size="xs" variant="light">{d.sms.length}</Badge> : null}>SMS</Tabs.Tab>
              <Tabs.Tab value="journey">Journey</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="overview" py="lg"><OverviewTab d={d} refresh={refresh} goBooking={() => setTab("booking")} goRisk={() => setTab("risk")} /></Tabs.Panel>
            <Tabs.Panel value="risk" py="lg"><RiskTab d={d} refresh={refresh} /></Tabs.Panel>
            <Tabs.Panel value="booking" py="lg"><BookingTab d={d} refresh={refresh} goCourier={() => setTab("courier")} /></Tabs.Panel>
            <Tabs.Panel value="courier" py="lg"><CourierTab d={d} refresh={refresh} /></Tabs.Panel>
            <Tabs.Panel value="notes" py="lg"><NotesTab d={d} refresh={refresh} /></Tabs.Panel>
            <Tabs.Panel value="sms" py="lg"><SmsTab orderId={d.order.id} phone={d.order.phone} messages={d.sms} refresh={refresh} /></Tabs.Panel>
            <Tabs.Panel value="journey" py="lg"><JourneyTab journey={d.journey} activity={d.activity} /></Tabs.Panel>
          </Tabs>
        </>
      ) : null}
    </Drawer>
  );
}

function DrawerHeader({ d, onClose, refresh, openRisk }: { d: OrderDetail; onClose: () => void; refresh: () => void; openRisk: () => void }) {
  const o = d.order;
  const can = useCan();
  const [cancelOpen, setCancelOpen] = useState(false);
  const remove = useMutation({
    mutationFn: () => post<{ deleted: boolean; archivedInShopify: boolean; message: string | null }>(`/orders/${o.id}/delete`),
    onSuccess: (r) => {
      r.deleted
        ? notifySuccess("Order deleted in Shopify and archived here")
        : notifySuccess(r.archivedInShopify ? `Shopify doesn't allow deleting this order (${r.message}). It was archived in Shopify and here instead.` : `Archived here. Shopify: ${r.message}`, "Archived");
      refresh();
    },
    onError: (e) => notifyError(e),
  });
  const confirmDelete = () =>
    modals.openConfirmModal({
      title: `Delete ${o.name}?`,
      children: <Text size="sm">Shopify only allows deleting some orders (typically cancelled or archived ones). If deletion isn't allowed, the order is archived in Shopify and in this dashboard instead. This cannot be undone.</Text>,
      labels: { confirm: "Delete or archive", cancel: "Keep order" },
      confirmProps: { color: "red" },
      onConfirm: () => remove.mutate(),
    });
  const refetch = useMutation({
    mutationFn: () => post(`/orders/${o.id}/refresh`),
    onSuccess: () => { notifySuccess("Order refreshed from Shopify"); refresh(); },
    onError: (e) => notifyError(e),
  });
  return (
    <div style={{ padding: "20px 24px 12px", borderBottom: "1px solid var(--app-border)", position: "sticky", top: 0, background: "var(--mantine-color-body)", zIndex: 5 }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Group gap="xs">
            <Title order={3} fw={600}>{o.name}</Title>
            {o.cancelledAt && <Badge color="dark">{o.shopifyDeletedAt ? "Deleted in Shopify" : "Cancelled"}</Badge>}
            {o.archived && <Badge color="gray">Archived</Badge>}
          </Group>
          <Text size="sm" c="dimmed" mt={2}>
            {dateTime(o.shopCreatedAt)} · {o.sourceName ? titleCase(o.sourceName) : "Shopify"} · {money(o.total)}
          </Text>
          <Group gap="xs" mt="sm" align="center">
            <OrderProgress order={{ ...o, courier: d.consignments.find((x) => x.id === o.activeConsignmentId)?.courier ?? null }} size="md" />
            <Badge size="sm" variant="outline" color={o.financialStatus === "paid" ? "teal" : "gray"}>{o.financialStatus === "paid" ? "Prepaid" : o.outstanding > 0 ? `COD ${money(o.outstanding)}` : titleCase(o.financialStatus)}</Badge>
            <RiskBadge flags={o.riskFlags} dismissed={o.riskDismissed} />
          </Group>
        </div>
        <Group gap={4} wrap="nowrap">
          {d.trackingPageUrl && (
            <CopyButton value={d.trackingPageUrl}>
              {({ copied, copy }) => (
                <Tooltip label={copied ? "Copied — send it to the customer" : "Copy customer tracking link"}>
                  <ActionIcon variant="default" size="lg" color={copied ? "teal" : undefined} onClick={copy} aria-label="Copy tracking link">
                    {copied ? <Check size={16} /> : <Link2 size={16} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          )}
          <Tooltip label="Open in Shopify">
            <ActionIcon variant="default" size="lg" component="a" href={d.shopifyUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} /></ActionIcon>
          </Tooltip>
          <Menu position="bottom-end">
            <Menu.Target><ActionIcon variant="default" size="lg" aria-label="More"><MoreVertical size={16} /></ActionIcon></Menu.Target>
            <Menu.Dropdown>
              {can("orders.edit") && <Menu.Item leftSection={<RefreshCw size={14} />} onClick={() => refetch.mutate()}>Refresh from Shopify</Menu.Item>}
              {can("export") && <Menu.Item leftSection={<Printer size={14} />} onClick={() => window.open(`/print?type=slip&ids=${o.id}`, "_blank")}>Print packing slip</Menu.Item>}
              {can("orders.cancel") && !o.cancelledAt && (
                <>
                  <Menu.Divider />
                  <Menu.Item color="red" leftSection={<Ban size={14} />} onClick={() => setCancelOpen(true)}>Cancel order in Shopify</Menu.Item>
                </>
              )}
              {can("orders.cancel") && !o.archived && (
                <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={confirmDelete}>Delete / archive order</Menu.Item>
              )}
            </Menu.Dropdown>
          </Menu>
          <ActionIcon variant="subtle" size="lg" color="gray" onClick={onClose} aria-label="Close">✕</ActionIcon>
        </Group>
      </Group>
      {!o.archived && <RiskBanner risk={d.risk} onOpen={openRisk} />}
      {o.cancelRequestedAt && !o.cancelledAt && <Alert color="gray" variant="light" mt="sm" py={6}>Cancellation sent to Shopify {ago(o.cancelRequestedAt)} — waiting for confirmation.</Alert>}
      <CancelOrderModal orderId={o.id} name={o.name} opened={cancelOpen} onClose={() => setCancelOpen(false)} onDone={refresh} />
    </div>
  );
}

function OverviewTab({ d, refresh, goBooking, goRisk }: { d: OrderDetail; refresh: () => void; goBooking: () => void; goRisk: () => void }) {
  const o = d.order;
  const can = useCan();
  const parcelCourier = d.consignments.find((x) => x.id === o.activeConsignmentId)?.courier ?? "steadfast";
  const statuses = useStatuses();
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/orders/${o.id}`, body),
    onSuccess: refresh,
    onError: (e) => notifyError(e),
  });
  const recheck = useMutation({ mutationFn: () => post(`/orders/${o.id}/recheck-risk`), onSuccess: refresh, onError: (e) => notifyError(e) });
  const [remark, setRemark] = useState(o.customerRemark ?? "");
  useEffect(() => setRemark(o.customerRemark ?? ""), [o.customerRemark]);
  const h = d.history;

  return (
    <Stack gap="lg">
      {!o.cancelledAt && (
        <CallingPanel orderId={o.id} status={o.callingStatus} attempts={o.callAttempts} callbackAt={o.callbackAt} locked={o.courierStage !== "unbooked"} calls={d.calls} onDone={refresh} />
      )}
      {o.courierStage === "unbooked" && !o.cancelledAt && o.callingStatus === "confirmed" && (
        <AutoBookPanel orderId={o.id} at={o.autoBookAt} note={o.autoBookNote} onDone={refresh} />
      )}
      {o.riskFlags && o.riskFlags.length > 0 && !o.riskDismissed && (
        <Alert color="orange" variant="light" icon={<AlertTriangle size={18} />} title="Review before booking">
          <Stack gap={4}>
            {o.riskFlags.map((f) => <Text size="sm" key={f}>• {RISK_FLAGS[f] ?? f}</Text>)}
          </Stack>
          {can("orders.edit") && (
            <Group mt="sm" gap="xs">
              <Button size="xs" variant="white" color="orange" leftSection={<ShieldCheck size={14} />} onClick={() => update.mutate({ riskDismissed: true })}>Mark as reviewed</Button>
              <Button size="xs" variant="subtle" color="orange" onClick={() => recheck.mutate()}>Re-check</Button>
            </Group>
          )}
        </Alert>
      )}
      {o.cancelledAt && o.courierStage !== "unbooked" && !["returned", "cancelled", "delivered", "partial_delivered"].includes(o.courierStage) && (
        <Alert color="red" variant="light" icon={<AlertTriangle size={18} />} title={o.shopifyDeletedAt ? "Deleted in Shopify after booking" : "Cancelled in Shopify after booking"}>
          {o.courierStage === "booked" && o.dispatchStatus !== "dispatched" ? (
            parcelCourier === "carrybee" ? (
              <>Keep this parcel here: don't hand it to the rider. Cancel it from the Courier tab (Cancel parcel at Carrybee).</>
            ) : (
              <>Keep this parcel here: don't hand it to the rider. Cancel it in the Steadfast portal (Steadfast has no cancel API); the dashboard updates by itself once Steadfast shows it cancelled.</>
            )
          ) : (
            parcelCourier === "carrybee" ? (
              <>Carrybee already has the parcel. Cancel it from the Courier tab (Cancel parcel at Carrybee) so it comes back.</>
            ) : (
              <>Steadfast already has the parcel. Create a return request from the Courier tab so it comes back.</>
            )
          )}
          {!o.shopifyDeletedAt && <> Reason: {o.cancelReason ? titleCase(o.cancelReason) : "none given"}.</>}
        </Alert>
      )}
      {o.shopifyDeletedAt && o.courierStage === "unbooked" && (
        <Alert color="gray" variant="light" title="Deleted in Shopify">This order no longer exists in Shopify. Nothing was sent to the courier, so there's nothing to stop.</Alert>
      )}

      <SourceCard channel={o.channel} sourceName={o.sourceName} attribution={o.attribution} />

      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
        <Card padding="md">
          <Group gap={6} mb="sm"><User size={15} /><Text fw={600} size="sm">Customer</Text></Group>
          <Text fw={500}>{o.customerName ?? "—"}</Text>
          <Group gap={6} mt={4}>
            <Phone size={13} />
            {o.phone ? <Copyable value={o.phone}><Anchor href={`tel:${o.phone}`} size="sm" className="mono">{o.phone}</Anchor></Copyable> : <Text size="sm" c="red">{o.rawPhone ? `Invalid: ${o.rawPhone}` : "No phone"}</Text>}
          </Group>
          {o.email && <Text size="sm" c="dimmed" mt={2}>{o.email}</Text>}
          {h && (
            <Group gap={6} mt="sm">
              <Badge size="sm" variant="light" color="gray">{h.orders} orders</Badge>
              <Badge size="sm" variant="light" color="teal">{h.delivered} delivered</Badge>
              {h.returned > 0 && <Badge size="sm" variant="light" color="red">{h.returned} returned</Badge>}
              {h.successRate !== null && <Badge size="sm" variant="light" color={h.successRate >= 80 ? "teal" : h.successRate >= 50 ? "yellow" : "red"}>{h.successRate}% success</Badge>}
            </Group>
          )}
          {d.customer?.flag && <Badge mt="xs" color={d.customer.flag === "blocked" ? "red" : d.customer.flag === "risky" ? "orange" : "grape"}>{titleCase(d.customer.flag)}</Badge>}
          {d.customer?.note && <Text size="xs" c="dimmed" mt="xs" fs="italic">“{d.customer.note}”</Text>}
        </Card>
        <Card padding="md">
          <Group gap={6} mb="sm"><MapPin size={15} /><Text fw={600} size="sm">Shipping address</Text></Group>
          <Text size="sm">{o.address1 || <Text span c="red" size="sm">No address</Text>}</Text>
          {o.address2 && <Text size="sm">{o.address2}</Text>}
          <Text size="sm">{[o.city, o.province, o.zip].filter(Boolean).join(", ")}</Text>
          <Text size="sm" c="dimmed">{o.country}</Text>
          {o.shippingMethod && <Text size="xs" c="dimmed" mt="xs">Shipping: {o.shippingMethod}</Text>}
          {can("orders.edit") && o.courierStage === "unbooked" && <Button size="xs" variant="light" mt="sm" onClick={goBooking}>Edit booking details</Button>}
        </Card>
      </SimpleGrid>

      <Card padding={0}>
        <Group p="md" pb="xs" gap={6}><Package size={15} /><Text fw={600} size="sm">Items</Text></Group>
        <Table className="app-table" verticalSpacing={8}>
          <Table.Tbody>
            {o.lineItems.map((li) => (
              <Table.Tr key={li.id} style={{ cursor: "default" }}>
                <Table.Td pl="md">
                  <Text size="sm" fw={500}>{li.title}</Text>
                  <Text size="xs" c="dimmed">{[li.variantTitle, li.sku && `SKU ${li.sku}`].filter(Boolean).join(" · ")}</Text>
                </Table.Td>
                <Table.Td ta="right"><Text size="sm" c="dimmed">{money(li.price, true)} × {li.quantity}</Text></Table.Td>
                <Table.Td ta="right" pr="md"><Text size="sm" fw={500}>{money(li.price * li.quantity, true)}</Text></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        <Stack gap={4} p="md" style={{ borderTop: "1px solid var(--app-border)" }}>
          <KeyValue label="Subtotal">{money(o.subtotal, true)}</KeyValue>
          <KeyValue label="Shipping">{money(o.shippingTotal, true)}</KeyValue>
          {o.discountTotal > 0 && <KeyValue label="Discount">−{money(o.discountTotal, true)}</KeyValue>}
          <KeyValue label="Total"><Text fw={600}>{money(o.total, true)}</Text></KeyValue>
          <KeyValue label="Outstanding (COD)"><Text fw={600} c={o.outstanding > 0 ? "brand" : undefined}>{money(o.outstanding, true)}</Text></KeyValue>
          <KeyValue label="Payment method">{(o.paymentGateways ?? []).join(", ") || "—"}</KeyValue>
        </Stack>
      </Card>

      {(o.shopifyNote || (o.noteAttributes ?? []).length > 0 || (o.shopifyTags ?? []).length > 0) && (
        <Card padding="md">
          <Text fw={600} size="sm" mb="xs">From Shopify</Text>
          {o.shopifyNote && <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{o.shopifyNote}</Text>}
          {(o.noteAttributes ?? []).map((a) => <KeyValue key={a.name} label={a.name}>{a.value}</KeyValue>)}
          {(o.shopifyTags ?? []).length > 0 && <Group gap={4} mt="xs">{o.shopifyTags!.map((t) => <Badge key={t} size="sm" variant="outline" color="gray">{t}</Badge>)}</Group>}
        </Card>
      )}

      <Card padding="md">
        <Text fw={600} size="sm" mb="sm">Internal</Text>
        <Stack gap="sm">
          <Select
            label="Order status"
            data={(statuses.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))}
            value={o.statusId ? String(o.statusId) : null}
            onChange={(v) => update.mutate({ statusId: v ? Number(v) : null })}
            clearable
            disabled={!can("orders.edit")}
            rightSection={o.statusId ? <CustomStatusBadge statusId={o.statusId} statuses={statuses.data} /> : undefined}
            rightSectionWidth={o.statusId ? 120 : undefined}
          />
          <TagsInput label="Tags" placeholder="Add tag and press Enter" value={o.internalTags ?? []} onChange={(tags) => update.mutate({ internalTags: tags })} disabled={!can("orders.edit")} clearable />
          <Textarea
            label="Customer remark"
            description="What the customer asked for (call notes, delivery time, gift wrap…)"
            autosize
            minRows={2}
            value={remark}
            onChange={(e) => setRemark(e.currentTarget.value)}
            onBlur={() => remark !== (o.customerRemark ?? "") && update.mutate({ customerRemark: remark || null })}
            disabled={!can("orders.edit")}
          />
        </Stack>
      </Card>

      {d.risk.previous.length > 0 && (
        <Card padding="sm" withBorder style={{ cursor: "pointer" }} onClick={goRisk}>
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              <b>{d.risk.previous.length}</b> other order{d.risk.previous.length === 1 ? "" : "s"} from this number
              {o.duplicateOfOrderId && <Badge size="xs" color="red" ml={6}>possible duplicate</Badge>}
            </Text>
            <Text size="xs" c="blue">See history in Risk →</Text>
          </Group>
        </Card>
      )}
    </Stack>
  );
}

function BookingTab({ d, refresh, goCourier }: { d: OrderDetail; refresh: () => void; goCourier: () => void }) {
  const o = d.order;
  const can = useCan();
  const courier = useBookingCourier();
  const editable = o.courierStage === "unbooked" && can("orders.edit");
  const [form, setForm] = useState<Booking>(d.booking);
  const [partial, setPartial] = useState<boolean>(Boolean(d.booking.lineItems?.length));
  useEffect(() => {
    setForm(d.booking);
    setPartial(Boolean(d.booking.lineItems?.length));
  }, [d.booking]);
  const dirty = JSON.stringify(form) !== JSON.stringify(d.booking);
  // Same customer's other confirmed orders: send them in this parcel (one delivery charge).
  const [together, setTogether] = useState<Set<number>>(new Set(d.combineCandidates.map((x) => x.id)));
  useEffect(() => setTogether(new Set(d.combineCandidates.map((x) => x.id))), [d.combineCandidates]);
  const combineIds = partial ? [] : d.combineCandidates.filter((x) => together.has(x.id)).map((x) => x.id);
  const parcelCod = (Number(form.codAmount) || 0) + d.combineCandidates.filter((x) => combineIds.includes(x.id)).reduce((sum, x) => sum + x.outstanding, 0);

  const save = useMutation({
    mutationFn: () => put(`/orders/${o.id}/booking`, { booking: { ...form, lineItems: partial ? form.lineItems ?? [] : [] } }),
    onSuccess: () => { notifySuccess("Booking details saved"); refresh(); },
    onError: (e) => notifyError(e, "Could not save"),
  });
  const reset = useMutation({ mutationFn: () => put(`/orders/${o.id}/booking`, { booking: null }), onSuccess: refresh, onError: (e) => notifyError(e) });
  const book = useMutation({
    mutationFn: async (allowRisky: boolean) => {
      if (dirty) await put(`/orders/${o.id}/booking`, { booking: { ...form, lineItems: partial ? form.lineItems ?? [] : [] } });
      return post<{ results: { ok: boolean; error?: string; trackingCode?: string }[] }>("/orders/book", { ids: [o.id, ...combineIds], allowRisky, combine: combineIds.length > 0 });
    },
    onSuccess: (r) => {
      const res = r.results[0];
      if (res?.ok) {
        notifySuccess(`Tracking code ${res.trackingCode}`, `Booked with ${courier.label}`);
        refresh();
        goCourier();
      } else notifyError(new Error(res?.error ?? "Booking failed"), `${courier.label} booking failed`);
      refresh();
    },
    onError: (e) => notifyError(e, "Booking failed"),
  });

  const confirmBook = () =>
    modals.openConfirmModal({
      title: `Book ${o.name} with ${courier.label}?`,
      children: (
        <Stack gap={4}>
          <Text size="sm">{form.recipientName} · {form.recipientPhone}</Text>
          <Text size="sm" c="dimmed">{form.recipientAddress}</Text>
          <Text size="sm" mt="xs">COD amount: <b>{money(parcelCod)}</b> · {form.deliveryType === 1 ? "Point delivery" : "Home delivery"}</Text>
          {combineIds.length > 0 && <Text size="sm">One parcel with {d.combineCandidates.filter((x) => combineIds.includes(x.id)).map((x) => x.name).join(", ")}</Text>}
          {d.fraud?.verdict === "risky" && <Alert color="red" mt="sm" variant="light">Steadfast fraud check: {d.fraud.reasons.join(", ")}. Book only after a confirming call.</Alert>}
          {o.riskFlags?.length && !o.riskDismissed ? <Alert color="orange" mt="sm" variant="light">This order has unreviewed risk flags.</Alert> : null}
        </Stack>
      ),
      labels: { confirm: "Book now", cancel: "Cancel" },
      onConfirm: () => book.mutate(d.customer?.flag === "blocked"),
    });

  const qtyFor = (id: string) => form.lineItems?.find((l) => l.lineItemId === id)?.quantity ?? 0;
  const setQty = (id: string, qty: number) => {
    const others = (form.lineItems ?? []).filter((l) => l.lineItemId !== id);
    setForm({ ...form, lineItems: qty > 0 ? [...others, { lineItemId: id, quantity: qty }] : others });
  };

  if (o.courierStage !== "unbooked") {
    const active = d.consignments.find((c) => c.id === o.activeConsignmentId);
    const others = d.parcelOrders.filter((x) => x.id !== o.id);
    return (
      <Alert color="blue" variant="light" icon={<Truck size={18} />} title="Already booked">
        <Text size="sm">This order was booked{active ? ` as ${active.invoice} (tracking ${active.trackingCode ?? "pending"})` : ""}. Booking details can no longer be edited.</Text>
        {others.length > 0 && (
          <Text size="sm" mt={6}>
            <b>One parcel</b> with {others.map((x) => `${x.name}${x.cancelledAt ? " (cancelled!)" : ""}`).join(", ")} · parcel COD {money(active?.codAmount ?? 0)}
          </Text>
        )}
        <Button size="xs" variant="white" mt="sm" onClick={goCourier}>View courier tracking</Button>
      </Alert>
    );
  }

  return (
    <Stack>
      {o.cancelledAt && <Alert color="red" variant="light">This order is cancelled in Shopify and cannot be booked.</Alert>}
      {!o.cancelledAt && o.callingStatus !== "confirmed" && (
        <Alert color="yellow" variant="light" title="Not confirmed yet">Call the customer and mark the order Confirmed before booking with {courier.label}.</Alert>
      )}
      {d.customer?.flag === "blocked" && <Alert color="red" variant="light" title="Blocked customer">Booking this order will override the block.</Alert>}
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label="Recipient name" required maxLength={100} value={form.recipientName} onChange={(e) => setForm({ ...form, recipientName: e.currentTarget.value })} disabled={!editable} />
        <TextInput label="Phone" required description="11-digit BD mobile" value={form.recipientPhone} onChange={(e) => setForm({ ...form, recipientPhone: e.currentTarget.value })} disabled={!editable} className="mono" />
        <TextInput label="Alternative phone" value={form.alternativePhone ?? ""} onChange={(e) => setForm({ ...form, alternativePhone: e.currentTarget.value || undefined })} disabled={!editable} />
        <TextInput label="Email" value={form.recipientEmail ?? ""} onChange={(e) => setForm({ ...form, recipientEmail: e.currentTarget.value || undefined })} disabled={!editable} />
      </SimpleGrid>
      <Textarea label="Address" required autosize minRows={2} maxLength={250} description={`${form.recipientAddress.length}/250`} value={form.recipientAddress} onChange={(e) => setForm({ ...form, recipientAddress: e.currentTarget.value })} disabled={!editable} />
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <NumberInput label="COD amount (৳)" min={0} thousandSeparator="," value={form.codAmount} onChange={(v) => setForm({ ...form, codAmount: Number(v) || 0 })} disabled={!editable} description={`Order outstanding: ${money(o.outstanding)}`} />
        <NumberInput label="Total lot" min={1} value={form.totalLot ?? ""} onChange={(v) => setForm({ ...form, totalLot: v === "" ? undefined : Number(v) })} disabled={!editable} />
        <div>
          <Text size="sm" fw={500} mb={4}>Delivery type</Text>
          <SegmentedControl fullWidth value={String(form.deliveryType)} onChange={(v) => setForm({ ...form, deliveryType: Number(v) as 0 | 1 })} disabled={!editable} data={[{ value: "0", label: "Home" }, { value: "1", label: "Point / hub" }]} />
        </div>
      </SimpleGrid>
      <TextInput label="Item description" maxLength={250} value={form.itemDescription ?? ""} onChange={(e) => setForm({ ...form, itemDescription: e.currentTarget.value || undefined })} disabled={!editable} />
      <Textarea label="Rider instructions / note" description={`Sent to ${courier.label} as the parcel note`} autosize minRows={2} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.currentTarget.value || undefined })} disabled={!editable} />

      {d.combineCandidates.length > 0 && (
        <Card padding="md" style={{ borderLeft: "4px solid var(--mantine-color-grape-5)" }}>
          <Group gap={8} mb={6}>
            <Package size={16} />
            <Text fw={600} size="sm">Same customer has {d.combineCandidates.length} more confirmed order{d.combineCandidates.length > 1 ? "s" : ""}</Text>
          </Group>
          <Text size="xs" c="dimmed" mb="xs">Send them in this parcel: one delivery charge and one return risk instead of several. Each order is still fulfilled and marked paid in Shopify on its own.</Text>
          <Stack gap={4}>
            {d.combineCandidates.map((x) => (
              <Checkbox
                key={x.id}
                disabled={partial || !can("courier.book")}
                checked={together.has(x.id) && !partial}
                onChange={() => {
                  const n = new Set(together);
                  n.has(x.id) ? n.delete(x.id) : n.add(x.id);
                  setTogether(n);
                }}
                label={<Text size="sm">{x.name} · {x.items} item{x.items === 1 ? "" : "s"} · COD {money(x.outstanding)}</Text>}
              />
            ))}
          </Stack>
          {partial ? (
            <Text size="xs" c="orange" mt={6}>A partial shipment can't be combined.</Text>
          ) : combineIds.length > 0 ? (
            <Text size="sm" mt="xs">Parcel COD: <b>{money(parcelCod)}</b></Text>
          ) : null}
        </Card>
      )}

      <Card padding="md">
        <Checkbox
          label="Ship only some items (partial fulfillment)"
          description="Only the selected quantities are fulfilled in Shopify when the courier picks up the parcel."
          checked={partial}
          onChange={(e) => {
            setPartial(e.currentTarget.checked);
            if (e.currentTarget.checked && !form.lineItems?.length) setForm({ ...form, lineItems: o.lineItems.map((li) => ({ lineItemId: li.id, quantity: li.quantity })) });
          }}
          disabled={!editable}
        />
        {partial && (
          <Stack gap={6} mt="sm">
            {o.lineItems.map((li) => (
              <Group key={li.id} justify="space-between" wrap="nowrap">
                <Text size="sm" lineClamp={1}>{li.title}{li.variantTitle ? ` — ${li.variantTitle}` : ""}</Text>
                <NumberInput size="xs" w={90} min={0} max={li.quantity} value={qtyFor(li.id)} onChange={(v) => setQty(li.id, Number(v) || 0)} disabled={!editable} suffix={` / ${li.quantity}`} />
              </Group>
            ))}
          </Stack>
        )}
      </Card>

      <Group justify="space-between">
        <Group gap="xs">
          {editable && o.booking && <Button variant="subtle" color="gray" onClick={() => reset.mutate()} loading={reset.isPending}>Reset to Shopify data</Button>}
        </Group>
        <Group gap="xs">
          {editable && <Button variant="default" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}
          {can("courier.book") && (
            <Button leftSection={<Send size={15} />} disabled={Boolean(o.cancelledAt) || o.callingStatus !== "confirmed"} loading={book.isPending} onClick={confirmBook}>
              {combineIds.length ? `Send ${combineIds.length + 1} orders as one parcel` : `Send to ${courier.label}`}
            </Button>
          )}
        </Group>
      </Group>
    </Stack>
  );
}

function CourierTab({ d, refresh }: { d: OrderDetail; refresh: () => void }) {
  const o = d.order;
  const can = useCan();
  const [returnFor, setReturnFor] = useState<number | null>(null);
  const [cancelFor, setCancelFor] = useState<number | null>(null);
  const [statusFor, setStatusFor] = useState<number | null>(null);
  const [message, setMessage] = useState("");

  const action = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post(path, body ?? {}),
    onSuccess: () => { refresh(); },
    onError: (e) => notifyError(e),
  });
  const fulfill = useMutation({
    mutationFn: () => post<{ fulfillmentState: string; fulfillmentError: string | null }>(`/orders/${o.id}/fulfill`),
    onSuccess: (r) => {
      r.fulfillmentState === "fulfilled" ? notifySuccess("Marked fulfilled in Shopify") : notifyError(new Error(r.fulfillmentError ?? "Queued for retry"), "Fulfillment not completed");
      refresh();
    },
    onError: (e) => notifyError(e),
  });

  if (!d.consignments.length) {
    return <Text c="dimmed" size="sm">No consignment yet. Use the Booking tab to send this order to the courier.</Text>;
  }

  return (
    <Stack gap="lg">
      <Card padding="md">
        <Group justify="space-between">
          <div>
            <Text fw={600} size="sm">Shopify fulfillment</Text>
            <Text size="xs" c="dimmed">Kept separate from courier delivery status</Text>
          </div>
          <Group gap="xs">
            <FulfillmentBadge state={o.fulfillmentState} />
            {can("fulfillment.manage") && o.fulfillmentState !== "fulfilled" && o.activeConsignmentId && (
              <Button size="xs" variant="light" leftSection={<PackageCheck size={14} />} loading={fulfill.isPending} onClick={() => fulfill.mutate()}>
                {o.fulfillmentState === "failed" ? "Retry fulfillment" : "Fulfill now"}
              </Button>
            )}
          </Group>
        </Group>
        {o.fulfillmentError && <Alert color="red" variant="light" mt="sm">{o.fulfillmentError}</Alert>}
        {o.fulfilledAt && <Text size="xs" c="dimmed" mt="xs">Fulfilled {dateTime(o.fulfilledAt)}</Text>}
      </Card>

      <Card padding="md">
        <Group justify="space-between">
          <div>
            <Text fw={600} size="sm">Label & dispatch</Text>
            <Text size="xs" c="dimmed">Label printed → scanned &amp; sorted → dispatched when the courier picks it up</Text>
          </div>
          <Group gap="xs">
            <LabelBadge status={o.labelStatus} />
            <DispatchBadge status={o.dispatchStatus} />
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt="sm" spacing="xs">
          <div><Text size="xs" c="dimmed">Booked</Text><Text size="sm">{o.bookedAt ? dateTime(o.bookedAt) : "—"}</Text></div>
          <div><Text size="xs" c="dimmed">Printed</Text><Text size="sm">{o.printedAt ? `${dateTime(o.printedAt)}${o.printCount > 1 ? ` (×${o.printCount})` : ""}` : "—"}</Text></div>
          <div><Text size="xs" c="dimmed">Sorted (scanned)</Text><Text size="sm">{o.sortedAt ? dateTime(o.sortedAt) : "—"}</Text>{o.sortedBy && <Text size="xs" c="dimmed">{o.sortedBy}</Text>}</div>
          <div><Text size="xs" c="dimmed">Dispatched (courier pickup)</Text><Text size="sm">{o.dispatchedAt ? dateTime(o.dispatchedAt) : "—"}</Text></div>
        </SimpleGrid>
        {d.dispatchHistory.length > 0 && (
          <Timeline bulletSize={12} lineWidth={2} mt="md">
            {d.dispatchHistory.slice(0, 12).map((e) => (
              <Timeline.Item key={e.id} title={<Text size="sm">{DISPATCH_EVENTS[e.event] ?? titleCase(e.event)} <Text span size="xs" c="dimmed">· {e.actor} · {ago(e.createdAt)}</Text></Text>}>
                {e.note && <Text size="xs" c="dimmed">{e.note}</Text>}
                {e.jobId && <Text size="xs" c="dimmed" className="mono">job {e.jobId.slice(0, 8)}</Text>}
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Card>

      {d.consignments.map((c) => {
        const events = d.events.filter((e) => e.consignmentRowId === c.id);
        const ret = d.returns.find((r) => r.consignmentRowId === c.id);
        return (
          <Card key={c.id} padding="md" style={{ opacity: c.superseded ? 0.65 : 1 }}>
            <Group justify="space-between" align="flex-start">
              <div>
                <Group gap="xs">
                  <Truck size={16} />
                  <Text fw={600}>{c.invoice}</Text>
                  {c.superseded && <Badge size="xs" color="gray">Superseded</Badge>}
                </Group>
                <Group gap="md" mt={6}>
                  {c.trackingCode && <Copyable value={c.trackingCode}><Anchor href={c.trackingUrl ?? undefined} target="_blank" className="mono">{c.trackingCode}</Anchor></Copyable>}
                  {c.consignmentId && <Text size="xs" c="dimmed">CID <span className="mono">{c.consignmentId}</span></Text>}
                </Group>
              </div>
              <Group gap="xs">
                <Badge size="sm" variant="outline" color={c.courier === "carrybee" ? "orange" : "gray"}>{COURIERS[c.courier as CourierId]?.label ?? c.courier}</Badge>
                <SteadfastStatusBadge status={c.status} courier={c.courier} />
                {can("courier.manage") && (
                  <Menu position="bottom-end">
                    <Menu.Target><ActionIcon variant="default" aria-label="Consignment actions"><MoreVertical size={15} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<RefreshCw size={14} />} onClick={() => action.mutate({ path: "/consignments/refresh", body: { ids: [c.id] } })}>Refresh status</Menu.Item>
                      <Menu.Item leftSection={<MessageSquarePlus size={14} />} onClick={() => setStatusFor(-c.id)}>Add delivery note</Menu.Item>
                      <Menu.Item leftSection={<CheckCircle2 size={14} />} onClick={() => setStatusFor(c.id)}>Set status manually</Menu.Item>
                      {c.courier === "carrybee" && !c.isFinal && c.consignmentId && (
                        <Menu.Item color="red" leftSection={<XCircle size={14} />} onClick={() => setCancelFor(c.id)}>Cancel parcel at Carrybee</Menu.Item>
                      )}
                      {c.courier === "steadfast" && ["delivered", "partial_delivered"].includes(c.stage) && !ret?.steadfastReturnId && (
                        <Menu.Item leftSection={<RotateCcw size={14} />} onClick={() => setReturnFor(c.id)}>Request return from customer</Menu.Item>
                      )}
                      {["returned", "cancelled"].includes(c.stage) && !c.superseded && (
                        <Menu.Item leftSection={<Send size={14} />} onClick={() => modals.openConfirmModal({
                          title: "Allow rebooking?",
                          children: <Text size="sm">The order moves back to "To book" so you can create a new consignment (redelivery). This consignment stays in history.</Text>,
                          labels: { confirm: "Release for rebooking", cancel: "Cancel" },
                          onConfirm: () => action.mutate({ path: `/consignments/${c.id}/release` }),
                        })}>Rebook / redeliver</Menu.Item>
                      )}
                      {c.status === "unconfirmed" && (
                        <Menu.Item color="red" leftSection={<Trash2 size={14} />} onClick={() => action.mutate({ path: `/consignments/${c.id}/discard` })}>Discard unconfirmed booking</Menu.Item>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                )}
              </Group>
            </Group>
            <SimpleGrid cols={{ base: 2, sm: 4 }} mt="md" spacing="xs">
              <div><Text size="xs" c="dimmed">COD</Text><Text size="sm" fw={500}>{money(c.codAmount)}</Text></div>
              <div><Text size="xs" c="dimmed">Collected</Text><Text size="sm" fw={500}>{money(c.collectedAmount)}</Text></div>
              <div><Text size="xs" c="dimmed">Delivery charge</Text><Text size="sm" fw={500}>{money(c.deliveryCharge)}</Text></div>
              <div><Text size="xs" c="dimmed">Settlement</Text><Text size="sm" fw={500}>{c.paymentId ? `Paid #${c.paymentId}` : ["delivered", "partial_delivered"].includes(c.stage) ? "Awaiting payout" : "—"}</Text></div>
            </SimpleGrid>
            {c.partialOutcome && (
              <Alert mt="sm" variant="light" color={c.partialOutcome === "charge_only" ? "orange" : "lime"} p="xs">
                <Text size="sm">{PARTIAL_OUTCOME_LABEL[c.partialOutcome]}{c.partialOutcome === "charge_only" ? " — the product is coming back to you" : ""}.</Text>
              </Alert>
            )}
            {c.stage === "awaiting_confirmation" && (
              <Alert mt="sm" variant="light" color="cyan" p="xs">
                <Text size="sm">The rider reported "{STEADFAST_STATUSES[c.status] ?? c.status}". Steadfast hasn't confirmed it yet, so the COD isn't counted until they do.</Text>
              </Alert>
            )}
            {c.codChangedFrom !== null && c.codChangedFrom !== undefined && (
              <Text size="xs" c="orange" mt="sm">COD was changed in the {COURIERS[c.courier as CourierId]?.label ?? "courier"} portal (was {money(c.codChangedFrom)}).</Text>
            )}
            {c.note && <Text size="xs" c="dimmed" mt="sm">Note: {c.note}</Text>}
            {ret && <Group gap={6} mt="sm"><Text size="xs" c="dimmed">Return:</Text><ReturnStatusBadge status={ret.status} />{ret.steadfastReturnStatus && <Badge size="xs" variant="outline">Steadfast: {ret.steadfastReturnStatus}</Badge>}</Group>}
            <Divider my="md" />
            <Timeline bulletSize={18} lineWidth={2} active={0}>
              {events.map((e) => (
                <Timeline.Item key={e.id} title={<Group gap={6}><Text size="sm" fw={500}>{e.status ? (c.courier === "carrybee" ? CARRYBEE_STATUSES[e.status] : STEADFAST_STATUSES[e.status]) ?? titleCase(e.status) : e.kind === "tracking" ? "Tracking update" : "Note"}</Text><Badge size="xs" variant="outline" color="gray">{e.source}</Badge></Group>}>
                  {e.message && <Text size="sm" c="dimmed">{e.message}</Text>}
                  <Text size="xs" c="dimmed" mt={2}>{dateTime(e.occurredAt)}</Text>
                </Timeline.Item>
              ))}
            </Timeline>
            <Text size="xs" c="dimmed" mt="sm">Last checked {ago(c.lastPolledAt ?? c.lastStatusAt)}</Text>
          </Card>
        );
      })}

      <Modal opened={cancelFor !== null} onClose={() => setCancelFor(null)} title="Cancel this parcel at Carrybee">
        <Stack>
          <Text size="sm" c="dimmed">Sends a cancellation to Carrybee. Before pickup the parcel is cancelled at once and the order can be booked again; after pickup Carrybee decides and its answer arrives by webhook.</Text>
          <Textarea label="Reason (sent to Carrybee)" value={message} onChange={(e) => setMessage(e.currentTarget.value)} autosize minRows={2} maxLength={190} />
          <Group justify="flex-end">
            <Button color="red" disabled={!message.trim()} loading={action.isPending} onClick={() => action.mutate({ path: `/consignments/${cancelFor}/cancel`, body: { reason: message } }, { onSuccess: () => { setCancelFor(null); setMessage(""); notifySuccess("Cancellation sent to Carrybee"); } })}>Cancel parcel</Button>
          </Group>
        </Stack>
      </Modal>
      <Modal opened={returnFor !== null} onClose={() => setReturnFor(null)} title="Request return via Steadfast">
        <Stack>
          <Text size="sm" c="dimmed">Creates a Steadfast return request for this delivered parcel. Refunds and restocking are never done automatically.</Text>
          <Textarea label="Reason" value={message} onChange={(e) => setMessage(e.currentTarget.value)} autosize minRows={2} />
          <Group justify="flex-end">
            <Button loading={action.isPending} onClick={() => action.mutate({ path: `/consignments/${returnFor}/return-request`, body: { reason: message || undefined } }, { onSuccess: () => { setReturnFor(null); setMessage(""); notifySuccess("Return request created"); } })}>Create return request</Button>
          </Group>
        </Stack>
      </Modal>
      <StatusModal
        consignmentId={statusFor}
        courier={d.consignments.find((x) => x.id === Math.abs(statusFor ?? 0))?.courier ?? "steadfast"}
        onClose={() => setStatusFor(null)}
        onSubmit={(body) => action.mutate(
          statusFor! < 0 ? { path: `/consignments/${-statusFor!}/note`, body } : { path: `/consignments/${statusFor}/status`, body },
          { onSuccess: () => setStatusFor(null) },
        )}
        loading={action.isPending}
      />
    </Stack>
  );
}

function StatusModal({ consignmentId, courier, onClose, onSubmit, loading }: { consignmentId: number | null; courier: string; onClose: () => void; onSubmit: (body: { status?: string; message?: string; collectedAmount?: number }) => void; loading: boolean }) {
  const noteOnly = consignmentId !== null && consignmentId < 0;
  const [status, setStatus] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [collected, setCollected] = useState<number | string>("");
  return (
    <Modal opened={consignmentId !== null} onClose={onClose} title={noteOnly ? "Add delivery note" : "Set status manually"}>
      <Stack>
        {!noteOnly && (
          <>
            <Text size="sm" c="dimmed">Use when {courierName(courier)} support confirmed a status that has not arrived via webhook. Logged in the timeline with your name.</Text>
            <Select label="Status" data={Object.entries(courier === "carrybee" ? CARRYBEE_STATUSES : STEADFAST_STATUSES).map(([value, label]) => ({ value, label }))} value={status} onChange={setStatus} />
            {(status?.includes("deliver") || status === "paid-return") && <NumberInput label="Collected amount (৳)" value={collected} onChange={setCollected} min={0} />}
          </>
        )}
        <Textarea label={noteOnly ? "Note" : "Reason"} value={message} onChange={(e) => setMessage(e.currentTarget.value)} autosize minRows={2} />
        <Group justify="flex-end">
          <Button
            loading={loading}
            disabled={noteOnly ? !message.trim() : !status}
            onClick={() => onSubmit(noteOnly ? { message } : { status: status!, message: message || undefined, collectedAmount: collected === "" ? undefined : Number(collected) })}
          >
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function NotesTab({ d, refresh }: { d: OrderDetail; refresh: () => void }) {
  const can = useCan();
  const [kind, setKind] = useState<string>("internal");
  const [body, setBody] = useState("");
  const [rating, setRating] = useState(0);
  const add = useMutation({
    mutationFn: () => post(`/orders/${d.order.id}/notes`, { kind, body, rating: rating || undefined }),
    onSuccess: () => { setBody(""); setRating(0); refresh(); },
    onError: (e) => notifyError(e),
  });
  const remove = useMutation({ mutationFn: (id: number) => del(`/orders/${d.order.id}/notes/${id}`), onSuccess: refresh, onError: (e) => notifyError(e) });
  const color: Record<string, string> = { internal: "gray", call_log: "blue", customer_remark: "grape", rider_instruction: "indigo", delivery_note: "cyan", rider_feedback: "orange", customer_review: "yellow" };
  return (
    <Stack>
      {can("orders.edit") && (
        <Card padding="md">
          <Stack gap="sm">
            <Select data={Object.entries(NOTE_KINDS).map(([value, label]) => ({ value, label }))} value={kind} onChange={(v) => setKind(v ?? "internal")} allowDeselect={false} />
            <Textarea placeholder={kind === "rider_instruction" ? "e.g. Call before delivery, deliver after 5 PM" : "Write a note…"} autosize minRows={2} value={body} onChange={(e) => setBody(e.currentTarget.value)} />
            {kind === "customer_review" && <Rating value={rating} onChange={setRating} />}
            {kind === "rider_instruction" && d.order.courierStage === "unbooked" && <Text size="xs" c="dimmed">Rider instructions are added to the courier booking note.</Text>}
            <Group justify="flex-end"><Button size="xs" disabled={!body.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add note</Button></Group>
          </Stack>
        </Card>
      )}
      {d.notes.length === 0 ? (
        <Text size="sm" c="dimmed">No notes yet.</Text>
      ) : (
        d.notes.map((n) => (
          <Card key={n.id} padding="sm">
            <Group justify="space-between" mb={4}>
              <Group gap={6}>
                <Badge size="xs" color={color[n.kind] ?? "gray"}>{NOTE_KINDS[n.kind as keyof typeof NOTE_KINDS] ?? n.kind}</Badge>
                {n.rating && <Rating value={n.rating} readOnly size="xs" />}
                <Text size="xs" c="dimmed">{n.userName ?? "System"} · {ago(n.createdAt)}</Text>
              </Group>
              {can("orders.edit") && <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => remove.mutate(n.id)} aria-label="Delete note"><Trash2 size={13} /></ActionIcon>}
            </Group>
            <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{n.body}</Text>
          </Card>
        ))
      )}
    </Stack>
  );
}

const CANCEL_REASONS = [
  { value: "FRAUD", label: "Fake / fraudulent order" },
  { value: "CUSTOMER", label: "Customer changed their mind" },
  { value: "INVENTORY", label: "Out of stock" },
  { value: "DECLINED", label: "Payment declined" },
  { value: "STAFF", label: "Staff error" },
  { value: "OTHER", label: "Other" },
];

function CancelOrderModal({ orderId, name, opened, onClose, onDone }: { orderId: number; name: string; opened: boolean; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState<string | null>("FRAUD");
  const [restock, setRestock] = useState(true);
  const [notify, setNotify] = useState(false);
  const [note, setNote] = useState("");
  const cancel = useMutation({
    mutationFn: () => post(`/orders/${orderId}/cancel`, { reason, restock, notifyCustomer: notify, staffNote: note || undefined }),
    onSuccess: () => {
      notifySuccess("Cancellation sent to Shopify", name);
      onClose();
      onDone();
    },
    onError: (e) => notifyError(e, "Shopify did not cancel the order"),
  });
  return (
    <Modal opened={opened} onClose={onClose} title={`Cancel ${name} in Shopify`}>
      <Stack>
        <Alert color="red" variant="light">Cancellation is permanent in Shopify. No refund is issued from here — refunds are always a separate decision.</Alert>
        <Select label="Reason" data={CANCEL_REASONS} value={reason} onChange={setReason} allowDeselect={false} />
        <Checkbox label="Restock items" checked={restock} onChange={(e) => setRestock(e.currentTarget.checked)} />
        <Checkbox label="Send cancellation email to customer" checked={notify} onChange={(e) => setNotify(e.currentTarget.checked)} />
        <TextInput label="Staff note (Shopify)" maxLength={255} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Keep order</Button>
          <Button color="red" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel order</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function AutoBookPanel({ orderId, at, note, onDone }: { orderId: number; at: string | null; note: string | null; onDone: () => void }) {
  const can = useCan();
  const left = useCountdown(at);
  const act = useMutation({
    mutationFn: (action: "cancel" | "now" | "restart") => post<{ results?: { ok: boolean; error?: string; trackingCode?: string }[] }>(`/orders/${orderId}/auto-book`, { action }),
    onSuccess: (r, action) => {
      if (action === "now") {
        const res = r.results?.[0];
        res?.ok ? notifySuccess(`Tracking ${res.trackingCode}`, "Booked with the courier") : notifyError(new Error(res?.error ?? "Booking failed"));
      }
      onDone();
    },
    onError: (e) => notifyError(e),
  });
  return (
    <Alert color={at ? "grape" : "gray"} variant="light" icon={<Timer size={18} />} title={at ? `Auto-booking in ${left}` : "Auto-booking off for this order"}>
      <Text size="sm">{at ? "This confirmed order is sent to the courier automatically when the timer ends." : note ?? "Book it manually, or restart the timer."}</Text>
      {can("courier.book") && (
        <Group gap="xs" mt="sm">
          <Button size="xs" leftSection={<Send size={14} />} loading={act.isPending && act.variables === "now"} onClick={() => act.mutate("now")}>Book now</Button>
          {at ? (
            <Button size="xs" variant="white" color="red" loading={act.isPending && act.variables === "cancel"} onClick={() => act.mutate("cancel")}>Cancel timer</Button>
          ) : (
            <Button size="xs" variant="white" loading={act.isPending && act.variables === "restart"} onClick={() => act.mutate("restart")}>Start timer</Button>
          )}
        </Group>
      )}
    </Alert>
  );
}
