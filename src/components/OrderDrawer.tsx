import { useEffect, useState } from "react";
import {
  ActionIcon, Alert, Anchor, Badge, Button, Card, Divider, Drawer, Group, Menu, NumberInput, Rating, ScrollArea, SegmentedControl, Select, SimpleGrid, Stack, Table, Tabs, TagsInput, Text, Textarea, TextInput, Timeline, Title, Tooltip, Checkbox, Modal,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modals } from "@mantine/modals";
import {
  AlertTriangle, Ban, ExternalLink, MapPin, MoreVertical, Package, Phone, RefreshCw, Send, Trash2, Truck, User, RotateCcw, CheckCircle2, ShieldCheck, Printer, MessageSquarePlus, PackageCheck,
} from "lucide-react";
import { api, del, notifyError, notifySuccess, patch, post, put } from "../api";
import { useCan } from "../auth";
import { CallingBadge, Copyable, CustomStatusBadge, DispatchBadge, ErrorState, FulfillmentBadge, KeyValue, LabelBadge, LoadingState, RiskBadge, ShopifySyncBadge, StageBadge, SteadfastStatusBadge, useStatuses, ReturnStatusBadge } from "./ui";
import { CallingPanel } from "./Calling";
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
          <DrawerHeader d={d} onClose={onClose} refresh={refresh} />
          <Tabs value={tab} onChange={setTab} px="lg" keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="overview">Overview</Tabs.Tab>
              <Tabs.Tab value="booking">Booking</Tabs.Tab>
              <Tabs.Tab value="courier" rightSection={d.consignments.length ? <Badge size="xs" variant="light">{d.consignments.length}</Badge> : null}>Courier</Tabs.Tab>
              <Tabs.Tab value="notes" rightSection={d.notes.length ? <Badge size="xs" variant="light">{d.notes.length}</Badge> : null}>Notes</Tabs.Tab>
              <Tabs.Tab value="activity">Activity</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="overview" py="lg"><OverviewTab d={d} refresh={refresh} goBooking={() => setTab("booking")} /></Tabs.Panel>
            <Tabs.Panel value="booking" py="lg"><BookingTab d={d} refresh={refresh} goCourier={() => setTab("courier")} /></Tabs.Panel>
            <Tabs.Panel value="courier" py="lg"><CourierTab d={d} refresh={refresh} /></Tabs.Panel>
            <Tabs.Panel value="notes" py="lg"><NotesTab d={d} refresh={refresh} /></Tabs.Panel>
            <Tabs.Panel value="activity" py="lg"><ActivityTab d={d} /></Tabs.Panel>
          </Tabs>
        </>
      ) : null}
    </Drawer>
  );
}

function DrawerHeader({ d, onClose, refresh }: { d: OrderDetail; onClose: () => void; refresh: () => void }) {
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
            {o.cancelledAt && <Badge color="dark">Cancelled</Badge>}
            {o.archived && <Badge color="gray">Archived</Badge>}
          </Group>
          <Text size="sm" c="dimmed" mt={2}>
            {dateTime(o.shopCreatedAt)} · {o.sourceName ? titleCase(o.sourceName) : "Shopify"} · {money(o.total)}
          </Text>
          <Group gap={6} mt="sm">
            <CallingBadge status={o.callingStatus} size="md" />
            <StageBadge stage={o.courierStage} size="md" />
            {o.labelStatus !== "not_ready" && <LabelBadge status={o.labelStatus} />}
            {o.dispatchStatus !== "pending" && <DispatchBadge status={o.dispatchStatus} />}
            <FulfillmentBadge state={o.fulfillmentState} error={o.fulfillmentError} />
            <ShopifySyncBadge status={o.shopifySyncStatus} error={o.shopifySyncError} />
            <Badge size="sm" variant="outline" color={o.financialStatus === "paid" ? "teal" : "gray"}>{titleCase(o.financialStatus)}</Badge>
            <RiskBadge flags={o.riskFlags} dismissed={o.riskDismissed} />
          </Group>
        </div>
        <Group gap={4} wrap="nowrap">
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
      {o.cancelRequestedAt && !o.cancelledAt && <Alert color="gray" variant="light" mt="sm" py={6}>Cancellation sent to Shopify {ago(o.cancelRequestedAt)} — waiting for confirmation.</Alert>}
      <CancelOrderModal orderId={o.id} name={o.name} opened={cancelOpen} onClose={() => setCancelOpen(false)} onDone={refresh} />
    </div>
  );
}

function OverviewTab({ d, refresh, goBooking }: { d: OrderDetail; refresh: () => void; goBooking: () => void }) {
  const o = d.order;
  const can = useCan();
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
      {o.cancelledAt && o.courierStage !== "unbooked" && !["returned", "cancelled", "delivered"].includes(o.courierStage) && (
        <Alert color="red" variant="light" icon={<AlertTriangle size={18} />} title="Cancelled in Shopify after booking">
          Contact Steadfast to stop this parcel ({o.cancelReason ? titleCase(o.cancelReason) : "no reason given"}).
        </Alert>
      )}

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

      {d.otherOrders.length > 0 && (
        <Card padding={0}>
          <Text fw={600} size="sm" p="md" pb="xs">Other orders from this phone</Text>
          <Table className="app-table" verticalSpacing={6}>
            <Table.Tbody>
              {d.otherOrders.map((x) => (
                <Table.Tr key={x.id} style={{ cursor: "default" }}>
                  <Table.Td pl="md"><Group gap={6}><Text size="sm" fw={500}>{x.name}</Text>{x.id === o.duplicateOfOrderId && <Badge size="xs" color="red">possible duplicate</Badge>}</Group></Table.Td>
                  <Table.Td><Text size="xs" c="dimmed">{ago(x.shopCreatedAt)}</Text></Table.Td>
                  <Table.Td>{x.cancelledAt ? <Badge size="xs" color="dark">Cancelled</Badge> : <StageBadge stage={x.courierStage} size="xs" />}</Table.Td>
                  <Table.Td ta="right" pr="md"><Text size="sm">{money(x.total)}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}
    </Stack>
  );
}

function BookingTab({ d, refresh, goCourier }: { d: OrderDetail; refresh: () => void; goCourier: () => void }) {
  const o = d.order;
  const can = useCan();
  const editable = o.courierStage === "unbooked" && can("orders.edit");
  const [form, setForm] = useState<Booking>(d.booking);
  const [partial, setPartial] = useState<boolean>(Boolean(d.booking.lineItems?.length));
  useEffect(() => {
    setForm(d.booking);
    setPartial(Boolean(d.booking.lineItems?.length));
  }, [d.booking]);
  const dirty = JSON.stringify(form) !== JSON.stringify(d.booking);

  const save = useMutation({
    mutationFn: () => put(`/orders/${o.id}/booking`, { booking: { ...form, lineItems: partial ? form.lineItems ?? [] : [] } }),
    onSuccess: () => { notifySuccess("Booking details saved"); refresh(); },
    onError: (e) => notifyError(e, "Could not save"),
  });
  const reset = useMutation({ mutationFn: () => put(`/orders/${o.id}/booking`, { booking: null }), onSuccess: refresh, onError: (e) => notifyError(e) });
  const book = useMutation({
    mutationFn: async (allowRisky: boolean) => {
      if (dirty) await put(`/orders/${o.id}/booking`, { booking: { ...form, lineItems: partial ? form.lineItems ?? [] : [] } });
      return post<{ results: { ok: boolean; error?: string; trackingCode?: string }[] }>("/orders/book", { ids: [o.id], allowRisky });
    },
    onSuccess: (r) => {
      const res = r.results[0];
      if (res?.ok) {
        notifySuccess(`Tracking code ${res.trackingCode}`, "Booked with Steadfast");
        refresh();
        goCourier();
      } else notifyError(new Error(res?.error ?? "Booking failed"), "Steadfast booking failed");
      refresh();
    },
    onError: (e) => notifyError(e, "Booking failed"),
  });

  const confirmBook = () =>
    modals.openConfirmModal({
      title: `Book ${o.name} with Steadfast?`,
      children: (
        <Stack gap={4}>
          <Text size="sm">{form.recipientName} · {form.recipientPhone}</Text>
          <Text size="sm" c="dimmed">{form.recipientAddress}</Text>
          <Text size="sm" mt="xs">COD amount: <b>{money(form.codAmount)}</b> · {form.deliveryType === 1 ? "Point delivery" : "Home delivery"}</Text>
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
    return (
      <Alert color="blue" variant="light" icon={<Truck size={18} />} title="Already booked">
        <Text size="sm">This order was booked{active ? ` as ${active.invoice} (tracking ${active.trackingCode ?? "pending"})` : ""}. Booking details can no longer be edited.</Text>
        <Button size="xs" variant="white" mt="sm" onClick={goCourier}>View courier tracking</Button>
      </Alert>
    );
  }

  return (
    <Stack>
      {o.cancelledAt && <Alert color="red" variant="light">This order is cancelled in Shopify and cannot be booked.</Alert>}
      {!o.cancelledAt && o.callingStatus !== "confirmed" && (
        <Alert color="yellow" variant="light" title="Not confirmed yet">Call the customer and mark the order Confirmed before booking with Steadfast.</Alert>
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
      <Textarea label="Rider instructions / note" description="Sent to Steadfast as the consignment note" autosize minRows={2} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.currentTarget.value || undefined })} disabled={!editable} />

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
              Book with Steadfast
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
    return <Text c="dimmed" size="sm">No consignment yet. Use the Booking tab to send this order to Steadfast.</Text>;
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
            <Text size="xs" c="dimmed">Labels are printed by the label service; dispatch is recorded by staff</Text>
          </div>
          <Group gap="xs">
            <LabelBadge status={o.labelStatus} />
            <DispatchBadge status={o.dispatchStatus} />
          </Group>
        </Group>
        <SimpleGrid cols={{ base: 2, sm: 4 }} mt="sm" spacing="xs">
          <div><Text size="xs" c="dimmed">Booked</Text><Text size="sm">{o.bookedAt ? dateTime(o.bookedAt) : "—"}</Text></div>
          <div><Text size="xs" c="dimmed">Printed</Text><Text size="sm">{o.printedAt ? `${dateTime(o.printedAt)}${o.printCount > 1 ? ` (×${o.printCount})` : ""}` : "—"}</Text></div>
          <div><Text size="xs" c="dimmed">Dispatched</Text><Text size="sm">{o.dispatchedAt ? `${dateTime(o.dispatchedAt)}` : "—"}</Text>{o.dispatchedBy && <Text size="xs" c="dimmed">{o.dispatchedBy}</Text>}</div>
          <div><Text size="xs" c="dimmed">Courier received</Text><Text size="sm">{o.courierReceivedAt ? dateTime(o.courierReceivedAt) : "—"}</Text></div>
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
                <SteadfastStatusBadge status={c.status} />
                {can("courier.manage") && (
                  <Menu position="bottom-end">
                    <Menu.Target><ActionIcon variant="default" aria-label="Consignment actions"><MoreVertical size={15} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item leftSection={<RefreshCw size={14} />} onClick={() => action.mutate({ path: "/consignments/refresh", body: { ids: [c.id] } })}>Refresh status</Menu.Item>
                      <Menu.Item leftSection={<MessageSquarePlus size={14} />} onClick={() => setStatusFor(-c.id)}>Add delivery note</Menu.Item>
                      <Menu.Item leftSection={<CheckCircle2 size={14} />} onClick={() => setStatusFor(c.id)}>Set status manually</Menu.Item>
                      {["delivered", "partial_delivered"].includes(c.stage) && !ret?.steadfastReturnId && (
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
            {c.note && <Text size="xs" c="dimmed" mt="sm">Note: {c.note}</Text>}
            {ret && <Group gap={6} mt="sm"><Text size="xs" c="dimmed">Return:</Text><ReturnStatusBadge status={ret.status} />{ret.steadfastReturnStatus && <Badge size="xs" variant="outline">Steadfast: {ret.steadfastReturnStatus}</Badge>}</Group>}
            <Divider my="md" />
            <Timeline bulletSize={18} lineWidth={2} active={0}>
              {events.map((e) => (
                <Timeline.Item key={e.id} title={<Group gap={6}><Text size="sm" fw={500}>{e.status ? STEADFAST_STATUSES[e.status] ?? titleCase(e.status) : e.kind === "tracking" ? "Tracking update" : "Note"}</Text><Badge size="xs" variant="outline" color="gray">{e.source}</Badge></Group>}>
                  {e.message && <Text size="sm" c="dimmed">{e.message}</Text>}
                  <Text size="xs" c="dimmed" mt={2}>{dateTime(e.occurredAt)}</Text>
                </Timeline.Item>
              ))}
            </Timeline>
            <Text size="xs" c="dimmed" mt="sm">Last checked {ago(c.lastPolledAt ?? c.lastStatusAt)}</Text>
          </Card>
        );
      })}

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

function StatusModal({ consignmentId, onClose, onSubmit, loading }: { consignmentId: number | null; onClose: () => void; onSubmit: (body: { status?: string; message?: string; collectedAmount?: number }) => void; loading: boolean }) {
  const noteOnly = consignmentId !== null && consignmentId < 0;
  const [status, setStatus] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [collected, setCollected] = useState<number | string>("");
  return (
    <Modal opened={consignmentId !== null} onClose={onClose} title={noteOnly ? "Add delivery note" : "Set status manually"}>
      <Stack>
        {!noteOnly && (
          <>
            <Text size="sm" c="dimmed">Use when Steadfast support confirmed a status that has not arrived via webhook. Logged in the timeline with your name.</Text>
            <Select label="Status" data={Object.entries(STEADFAST_STATUSES).map(([value, label]) => ({ value, label }))} value={status} onChange={setStatus} />
            {status?.includes("delivered") && <NumberInput label="Collected amount (৳)" value={collected} onChange={setCollected} min={0} />}
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
            {kind === "rider_instruction" && d.order.courierStage === "unbooked" && <Text size="xs" c="dimmed">Rider instructions are added to the Steadfast booking note.</Text>}
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

function ActivityTab({ d }: { d: OrderDetail }) {
  if (!d.activity.length) return <Text size="sm" c="dimmed">No activity recorded.</Text>;
  return (
    <Timeline bulletSize={14} lineWidth={2}>
      {d.activity.map((a) => (
        <Timeline.Item key={a.id} title={<Text size="sm"><b>{a.actor}</b> <Text span c="dimmed">{titleCase(a.action.replace(".", " · "))}</Text></Text>}>
          {a.details && typeof a.details === "object" && Object.keys(a.details as object).length > 0 ? (
            <Text size="xs" c="dimmed" className="mono" lineClamp={3}>{JSON.stringify(a.details)}</Text>
          ) : null}
          <Text size="xs" c="dimmed">{dateTime(a.createdAt)}</Text>
        </Timeline.Item>
      ))}
    </Timeline>
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
