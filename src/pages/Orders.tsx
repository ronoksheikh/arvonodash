import { useEffect, useMemo, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { Tooltip, ActionIcon, Anchor, Badge, Button, Checkbox, Group, Menu, Modal, ScrollArea, Select, Stack, Switch, Table, Tabs, Text, TextInput, Affix, Paper, Transition, Alert, List } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { PhoneCall, ArrowDownUp, Download, Filter, MoreHorizontal, Printer, Search, Send, Tag, X, CheckCircle2, XCircle, Archive, ShieldOff, ListChecks } from "lucide-react";
import { api, post, qs, notifyError, notifySuccess } from "../api";
import { useCan } from "../auth";
import { AutoBookChip, CustomerHistoryBadge, CustomStatusBadge, DispatchBadge, EmptyState, ErrorState, FulfillmentBadge, LabelBadge, LoadingState, PageHeader, Panel, RiskBadge, ShopifySyncBadge, StageBadge, TableFooter, useStatuses } from "../components/ui";
import { CallingMenu } from "../components/Calling";
import { OrderDrawer } from "../components/OrderDrawer";
import { dateShort, money } from "../format";
import { CALLING_STATUSES } from "../../shared/constants";
import type { OrderListRow } from "../types";

const TABS = [
  { value: "all", label: "All" },
  { value: "to_call", label: "To call" },
  { value: "ready", label: "Ready to book" },
  { value: "booked", label: "Booked" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
  { value: "returned", label: "Returned" },
  { value: "cancelled", label: "Cancelled" },
  { value: "attention", label: "Attention" },
];

type ListResponse = { rows: OrderListRow[]; total: number; page: number; pageSize: number; tabCounts: Record<string, number> };
type BookResult = { orderId: number; name?: string; ok: boolean; error?: string; trackingCode?: string };

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const qc = useQueryClient();
  const statuses = useStatuses();
  const tab = params.get("tab") ?? "all";
  const page = Number(params.get("page") ?? 1);
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [debounced] = useDebouncedValue(search, 300);
  const [range, setRange] = useState<[string | null, string | null]>([null, null]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bookOpen, setBookOpen] = useState(false);
  const [results, setResults] = useState<BookResult[] | null>(null);
  const [tagModal, setTagModal] = useState<"add_tag" | "remove_tag" | null>(null);
  const openId = params.get("open") ? Number(params.get("open")) : null;

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null || v === "" ? next.delete(k) : next.set(k, v);
    setParams(next, { replace: true });
  };

  useEffect(() => {
    if ((params.get("search") ?? "") !== debounced) set({ search: debounced || null, page: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    // Global search from the header updates the URL directly.
    const s = params.get("search") ?? "";
    if (s !== search && s !== debounced) setSearch(s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const filters = {
    tab,
    page,
    search: params.get("search"),
    statusId: params.get("statusId"),
    flagged: params.get("flagged"),
    tag: params.get("tag"),
    sort: params.get("sort") ?? "created",
    dir: params.get("dir") ?? "desc",
    from: range[0] ? new Date(range[0]).toISOString() : null,
    to: range[1] ? new Date(new Date(range[1]).getTime() + 86_400_000 - 1).toISOString() : null,
    archived: params.get("archived"),
  };
  const query = useQuery({
    queryKey: ["orders", filters],
    queryFn: () => api<ListResponse>(`/orders${qs({ ...filters, pageSize: 50 })}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const rows = query.data?.rows ?? [];

  // Notify when new orders arrive while the page is open.
  const newestSeen = useRef<number | null>(null);
  useEffect(() => {
    const max = Math.max(0, ...rows.map((r) => r.id));
    if (!rows.length) return;
    if (newestSeen.current !== null && max > newestSeen.current) {
      const fresh = rows.filter((r) => r.id > newestSeen.current!).length;
      notifications.show({ color: "brand", title: "New orders", message: `${fresh} new order${fresh === 1 ? "" : "s"} from Shopify` });
    }
    newestSeen.current = Math.max(newestSeen.current ?? 0, max);
  }, [rows]);

  const quickConfirm = useMutation({
    mutationFn: (id: number) => post<{ autoBookAt: string | null }>(`/orders/${id}/calling`, { status: "confirmed" }),
    onSuccess: (r) => {
      notifySuccess(r.autoBookAt ? "Confirmed — auto-booking in a few minutes" : "Confirmed");
      invalidate();
    },
    onError: (e) => notifyError(e),
  });
  const selectedRows = useMemo(() => rows.filter((r) => selected.has(r.id)), [rows, selected]);

  useEffect(() => setSelected(new Set()), [tab, filters.search, filters.statusId, page]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["order"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
    qc.invalidateQueries({ queryKey: ["nav-counts"] });
  };

  const bulk = useMutation({
    mutationFn: (body: { action: string; value?: string | number | null }) => post("/orders/bulk", { ids: [...selected], ...body }),
    onSuccess: () => {
      notifySuccess(`Updated ${selected.size} orders`);
      invalidate();
    },
    onError: (e) => notifyError(e),
  });

  const bulkCalling = useMutation({
    mutationFn: (status: string) => post<{ updated: number; results: { ok: boolean; error?: string }[] }>("/orders/calling/bulk", { ids: [...selected], status }),
    onSuccess: (r) => {
      const failed = r.results.filter((x) => !x.ok);
      failed.length ? notifyError(new Error(`${failed.length} not changed: ${failed[0].error}`), `Updated ${r.updated}`) : notifySuccess(`Updated ${r.updated} orders`);
      invalidate();
    },
    onError: (e) => notifyError(e),
  });

  const book = useMutation({
    mutationFn: async ({ ids, allowRisky }: { ids: number[]; allowRisky: boolean }) => {
      const all: BookResult[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const r = await post<{ results: BookResult[] }>("/orders/book", { ids: ids.slice(i, i + 50), allowRisky });
        all.push(...r.results);
      }
      return all;
    },
    onSuccess: (r) => {
      setBookOpen(false);
      setResults(r);
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => notifyError(e, "Booking failed"),
  });

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const toggleAll = () => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)));
  const toggle = (id: number) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const exportCsv = () => {
    const ids = selected.size ? [...selected].join(",") : undefined;
    window.location.href = `/api/orders/export.csv${qs({ ...filters, page: undefined, ids })}`;
  };
  const print = (type: "slip") => window.open(`/print?type=${type}&ids=${[...selected].join(",")}`, "_blank");
  const sortBy = (key: string) => set({ sort: key, dir: filters.sort === key && filters.dir === "desc" ? "asc" : "desc" });

  const bookable = selectedRows.filter((r) => r.courierStage === "unbooked" && !r.cancelledAt && r.callingStatus === "confirmed");

  return (
    <>
      <PageHeader
        title="Orders"
        description="Shopify orders synced in real time. Confirmed orders are booked with Steadfast after a short timer (or manually)."
        actions={
          <>
            {can("export") && (
              <Button variant="default" leftSection={<Download size={15} />} onClick={exportCsv}>
                Export CSV
              </Button>
            )}
          </>
        }
      />

      <Panel>
        <Tabs value={tab} onChange={(v) => set({ tab: v === "all" ? null : v, page: null })} px="md" pt={6}>
          <Tabs.List style={{ flexWrap: "nowrap", overflowX: "auto" }}>
            {TABS.map((t) => (
              <Tabs.Tab
                key={t.value}
                value={t.value}
                rightSection={
                  query.data?.tabCounts[t.value] !== undefined ? (
                    <Badge size="xs" variant={tab === t.value ? "filled" : "light"} color={t.value === "attention" && query.data.tabCounts[t.value] ? "orange" : tab === t.value ? "brand" : "gray"}>
                      {query.data.tabCounts[t.value]}
                    </Badge>
                  ) : null
                }
              >
                {t.label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs>

        <Group p="md" gap="sm" wrap="wrap">
          <TextInput
            placeholder="Search order #, name, phone, address, tracking…"
            leftSection={<Search size={15} />}
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            rightSection={search ? <ActionIcon size="sm" variant="subtle" onClick={() => setSearch("")}><X size={14} /></ActionIcon> : null}
            style={{ flex: "1 1 260px" }}
          />
          <Select
            placeholder="Any status"
            leftSection={<Filter size={14} />}
            clearable
            data={[{ value: "none", label: "No status" }, ...(statuses.data ?? []).map((s) => ({ value: String(s.id), label: s.name }))]}
            value={filters.statusId}
            onChange={(v) => set({ statusId: v, page: null })}
            w={180}
          />
          <DatePickerInput
            type="range"
            placeholder="Date range"
            value={range}
            onChange={(v) => {
              setRange(v as [string | null, string | null]);
              set({ page: null });
            }}
            clearable
            w={230}
            maxDate={new Date()}
          />
          <Switch label="Flagged only" checked={filters.flagged === "1"} onChange={(e) => set({ flagged: e.currentTarget.checked ? "1" : null, page: null })} />
          {filters.tag && (
            <Badge size="lg" variant="light" rightSection={<X size={12} style={{ cursor: "pointer" }} onClick={() => set({ tag: null })} />}>
              Tag: {filters.tag}
            </Badge>
          )}
          <Switch label="Archived" checked={filters.archived === "1"} onChange={(e) => set({ archived: e.currentTarget.checked ? "1" : null, page: null })} />
        </Group>

        {query.isLoading ? (
          <LoadingState />
        ) : query.error ? (
          <div style={{ padding: 16 }}><ErrorState error={query.error} onRetry={() => query.refetch()} /></div>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No orders found"
            description={filters.search || filters.statusId || filters.flagged ? "Try clearing filters." : "Orders arrive automatically from Shopify webhooks. Import historical orders from Sync & webhooks."}
          />
        ) : (
          <>
            <ScrollArea>
              <Table className="app-table" verticalSpacing={10} highlightOnHover={false} miw={1100}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={40} pl="md"><Checkbox size="xs" checked={allChecked} indeterminate={selected.size > 0 && !allChecked} onChange={toggleAll} aria-label="Select all" /></Table.Th>
                    <Table.Th onClick={() => sortBy("name")} style={{ cursor: "pointer" }}>Order <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th onClick={() => sortBy("created")} style={{ cursor: "pointer" }}>Date <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th onClick={() => sortBy("customer")} style={{ cursor: "pointer" }}>Customer <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th ta="right" onClick={() => sortBy("total")} style={{ cursor: "pointer" }}>Total <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th>Payment</Table.Th>
                    <Table.Th>Calling</Table.Th>
                    <Table.Th>Courier</Table.Th>
                    <Table.Th>Label · Dispatch</Table.Th>
                    <Table.Th>Fulfillment</Table.Th>
                    <Table.Th pr="md">Flags</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {rows.map((o) => (
                    <Table.Tr key={o.id} data-selected={selected.has(o.id)} onClick={() => set({ open: String(o.id) })}>
                      <Table.Td pl="md" onClick={(e) => e.stopPropagation()}>
                        <Checkbox size="xs" checked={selected.has(o.id)} onChange={() => toggle(o.id)} aria-label={`Select ${o.name}`} />
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" fw={600}>{o.name}</Text>
                        <Text size="xs" c="dimmed">{o.itemCount} item{o.itemCount === 1 ? "" : "s"}</Text>
                      </Table.Td>
                      <Table.Td><Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>{dateShort(o.shopCreatedAt)}</Text></Table.Td>
                      <Table.Td maw={260}>
                        <Group gap={6} wrap="nowrap">
                          <Text size="sm" lineClamp={1}>{o.customerName ?? "—"}</Text>
                          <CustomerHistoryBadge orders={o.customerOrders} delivered={o.customerDelivered} returned={o.customerReturned} flag={o.customerFlag} />
                        </Group>
                        <Group gap={4} wrap="nowrap">
                          {o.phone ? (
                            <Anchor href={`tel:${o.phone}`} size="xs" className="mono" onClick={(e) => e.stopPropagation()}>{o.phone}</Anchor>
                          ) : (
                            <Text size="xs" c="red" className="mono">{o.rawPhone ?? "No phone"}</Text>
                          )}
                          {o.city && <Text size="xs" c="dimmed">· {o.city}</Text>}
                        </Group>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={500} style={{ fontVariantNumeric: "tabular-nums" }}>{money(o.total)}</Text>
                        {o.outstanding > 0 && o.outstanding !== o.total && <Text size="xs" c="dimmed">COD {money(o.outstanding)}</Text>}
                      </Table.Td>
                      <Table.Td>
                        {o.cancelledAt ? <Badge color="dark" size="sm">Cancelled</Badge> : <Badge color={o.financialStatus === "paid" ? "teal" : "gray"} size="sm" variant="outline">{o.financialStatus === "paid" ? "Prepaid" : o.outstanding > 0 ? "COD" : (o.financialStatus ?? "—")}</Badge>}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <CallingMenu orderId={o.id} status={o.callingStatus} locked={o.courierStage !== "unbooked" || Boolean(o.cancelledAt)} onDone={invalidate} />
                          {tab === "to_call" && can("orders.call") && (
                            <Tooltip label="Confirmed">
                              <ActionIcon size="sm" color="teal" variant="light" aria-label="Confirm" loading={quickConfirm.isPending && quickConfirm.variables === o.id} onClick={(e) => { e.stopPropagation(); quickConfirm.mutate(o.id); }}>
                                <CheckCircle2 size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                        {o.callAttempts > 0 && <Text size="xs" c="dimmed" mt={2}>{o.callAttempts} call{o.callAttempts === 1 ? "" : "s"}{o.callbackAt ? ` · ${dateShort(o.callbackAt)}` : ""}</Text>}
                      </Table.Td>
                      <Table.Td>
                        <StageBadge stage={o.courierStage} />
                        {o.trackingCode && <Text size="xs" c="dimmed" className="mono" mt={2}>{o.trackingCode}</Text>}
                        {o.autoBookAt && o.courierStage === "unbooked" && <div style={{ marginTop: 4 }}><AutoBookChip at={o.autoBookAt} /></div>}
                        {!o.autoBookAt && o.autoBookNote && o.courierStage === "unbooked" && <Text size="xs" c="orange" lineClamp={2} maw={180}>{o.autoBookNote}</Text>}
                      </Table.Td>
                      <Table.Td>
                        {o.labelStatus === "not_ready" ? <Text size="xs" c="dimmed">—</Text> : (
                          <Stack gap={4} align="flex-start">
                            <LabelBadge status={o.labelStatus} />
                            {o.dispatchStatus !== "pending" && <DispatchBadge status={o.dispatchStatus} />}
                          </Stack>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={4} align="flex-start">
                          <FulfillmentBadge state={o.fulfillmentState} error={o.fulfillmentError} />
                          {o.shopifySyncStatus === "failed" && <ShopifySyncBadge status={o.shopifySyncStatus} />}
                        </Stack>
                      </Table.Td>
                      <Table.Td pr="md">
                        <Group gap={4}>
                          {o.statusId && <CustomStatusBadge statusId={o.statusId} statuses={statuses.data} />}
                          {o.cancelRequestedAt && !o.cancelledAt && <Badge size="sm" color="dark" variant="outline">Cancelling…</Badge>}
                          <RiskBadge flags={o.riskFlags} dismissed={o.riskDismissed} />
                          {(o.internalTags ?? []).slice(0, 2).map((t) => (
                            <Badge key={t} size="sm" color="gray" variant="outline" onClick={(e) => { e.stopPropagation(); set({ tag: t }); }} style={{ cursor: "pointer" }}>{t}</Badge>
                          ))}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
            <TableFooter page={page} pageSize={50} total={query.data?.total ?? 0} onPage={(p) => set({ page: String(p) })} />
          </>
        )}
      </Panel>

      {/* Bulk action bar */}
      <Affix position={{ bottom: 20, left: 0, right: 0 }} zIndex={150}>
        <Transition mounted={selected.size > 0} transition="slide-up">
          {(style) => (
            <Group justify="center" style={style} px="md">
              <Paper shadow="lg" withBorder radius="xl" px="md" py={8} className="app-panel">
                <Group gap="xs" wrap="wrap" justify="center">
                  <Text size="sm" fw={600} px={4}>{selected.size} selected</Text>
                  {can("orders.call") && (
                    <Menu position="top">
                      <Menu.Target><Button size="xs" variant="default" leftSection={<PhoneCall size={14} />}>Calling</Button></Menu.Target>
                      <Menu.Dropdown>
                        {Object.entries(CALLING_STATUSES).filter(([k]) => k !== "not_called").map(([k, st]) => (
                          <Menu.Item key={k} onClick={() => bulkCalling.mutate(k)}><Badge color={st.color} size="sm">{st.label}</Badge></Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                  )}
                  {can("courier.book") && (
                    <Button size="xs" leftSection={<Send size={14} />} disabled={!bookable.length} onClick={() => setBookOpen(true)}>
                      Book with Steadfast{bookable.length !== selected.size && bookable.length ? ` (${bookable.length})` : ""}
                    </Button>
                  )}
                  {can("orders.edit") && (
                    <Menu position="top">
                      <Menu.Target><Button size="xs" variant="default" leftSection={<ListChecks size={14} />}>Set status</Button></Menu.Target>
                      <Menu.Dropdown>
                        {(statuses.data ?? []).map((s) => (
                          <Menu.Item key={s.id} onClick={() => bulk.mutate({ action: "set_status", value: s.id })}>
                            <Badge color={s.color} size="sm">{s.name}</Badge>
                          </Menu.Item>
                        ))}
                        <Menu.Item onClick={() => bulk.mutate({ action: "set_status", value: null })}>Clear status</Menu.Item>
                      </Menu.Dropdown>
                    </Menu>
                  )}
                  {can("export") && (
                    <>
                      <Button size="xs" variant="default" leftSection={<Printer size={14} />} onClick={() => print("slip")}>Packing slips</Button>
                    </>
                  )}
                  <Menu position="top-end">
                    <Menu.Target><ActionIcon variant="default" size="md" radius="md" aria-label="More actions"><MoreHorizontal size={16} /></ActionIcon></Menu.Target>
                    <Menu.Dropdown>
                      {can("orders.edit") && <Menu.Item leftSection={<Tag size={14} />} onClick={() => setTagModal("add_tag")}>Add tag</Menu.Item>}
                      {can("orders.edit") && <Menu.Item leftSection={<Tag size={14} />} onClick={() => setTagModal("remove_tag")}>Remove tag</Menu.Item>}
                      {can("orders.edit") && <Menu.Item leftSection={<ShieldOff size={14} />} onClick={() => bulk.mutate({ action: "dismiss_risk" })}>Dismiss flags</Menu.Item>}
                      {can("export") && <Menu.Item leftSection={<Download size={14} />} onClick={exportCsv}>Export selected</Menu.Item>}
                      {can("orders.edit") && (
                        <Menu.Item leftSection={<Archive size={14} />} onClick={() => bulk.mutate({ action: filters.archived === "1" ? "unarchive" : "archive" })}>
                          {filters.archived === "1" ? "Unarchive" : "Archive"}
                        </Menu.Item>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                  <ActionIcon variant="subtle" color="gray" onClick={() => setSelected(new Set())} aria-label="Clear selection"><X size={16} /></ActionIcon>
                </Group>
              </Paper>
            </Group>
          )}
        </Transition>
      </Affix>

      <BookModal opened={bookOpen} onClose={() => setBookOpen(false)} rows={bookable} skipped={selected.size - bookable.length} loading={book.isPending} onConfirm={(allowRisky) => book.mutate({ ids: bookable.map((r) => r.id), allowRisky })} />

      <Modal opened={results !== null} onClose={() => setResults(null)} title="Booking results" size="lg">
        {results && (
          <Stack>
            <Group>
              <Badge color="teal" size="lg" leftSection={<CheckCircle2 size={14} />}>{results.filter((r) => r.ok).length} booked</Badge>
              {results.some((r) => !r.ok) && <Badge color="red" size="lg" leftSection={<XCircle size={14} />}>{results.filter((r) => !r.ok).length} failed</Badge>}
            </Group>
            <ScrollArea.Autosize mah={400}>
              <Table className="app-table">
                <Table.Tbody>
                  {results.map((r) => (
                    <Table.Tr key={r.orderId} onClick={() => { setResults(null); set({ open: String(r.orderId) }); }}>
                      <Table.Td><Text size="sm" fw={600}>{r.name ?? r.orderId}</Text></Table.Td>
                      <Table.Td>{r.ok ? <Text size="sm" className="mono" c="teal">{r.trackingCode}</Text> : <Text size="sm" c="red">{r.error}</Text>}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea.Autosize>
            {results.some((r) => r.ok) && (
              <Text size="sm" c="dimmed">Booked orders are now in Ready to print for the label service.</Text>
            )}
          </Stack>
        )}
      </Modal>

      <TagModal mode={tagModal} onClose={() => setTagModal(null)} onSubmit={(tag) => { bulk.mutate({ action: tagModal!, value: tag }); setTagModal(null); }} />

      <OrderDrawer orderId={openId} onClose={() => set({ open: null })} onChanged={invalidate} />
    </>
  );
}

function BookModal({ opened, onClose, rows, skipped, loading, onConfirm }: { opened: boolean; onClose: () => void; rows: OrderListRow[]; skipped: number; loading: boolean; onConfirm: (allowRisky: boolean) => void }) {
  const [allowRisky, setAllowRisky] = useState(false);
  const flagged = rows.filter((r) => r.riskFlags?.length && !r.riskDismissed);
  const noPhone = rows.filter((r) => !r.phone);
  const cod = rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>Book {rows.length} order{rows.length === 1 ? "" : "s"} with Steadfast</Text>} size="md">
      <Stack>
        <Text size="sm">
          This creates Steadfast consignments using each order's booking details (edited values where saved). Total COD: <b>{money(cod)}</b>.
        </Text>
        {skipped > 0 && <Alert color="gray" variant="light">{skipped} selected order(s) are not confirmed, already booked or cancelled and will be skipped.</Alert>}
        {flagged.length > 0 && (
          <Alert color="orange" variant="light" title={`${flagged.length} flagged order(s)`}>
            <List size="sm">{flagged.slice(0, 6).map((r) => <List.Item key={r.id}>{r.name} — {r.customerName}</List.Item>)}</List>
            {flagged.length > 6 && <Text size="xs" mt={4}>and {flagged.length - 6} more</Text>}
          </Alert>
        )}
        {noPhone.length > 0 && <Alert color="red" variant="light">{noPhone.length} order(s) have no valid phone number and will fail unless you edit their booking details first.</Alert>}
        <Checkbox label="Also book orders from blocked customers" checked={allowRisky} onChange={(e) => setAllowRisky(e.currentTarget.checked)} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>Cancel</Button>
          <Button leftSection={<Send size={15} />} loading={loading} onClick={() => onConfirm(allowRisky)}>Book {rows.length} order{rows.length === 1 ? "" : "s"}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function TagModal({ mode, onClose, onSubmit }: { mode: "add_tag" | "remove_tag" | null; onClose: () => void; onSubmit: (tag: string) => void }) {
  const [tag, setTag] = useState("");
  return (
    <Modal opened={mode !== null} onClose={onClose} title={mode === "add_tag" ? "Add tag" : "Remove tag"} size="sm">
      <form onSubmit={(e) => { e.preventDefault(); if (tag.trim()) onSubmit(tag.trim()); setTag(""); }}>
        <Stack>
          <TextInput label="Tag" placeholder="e.g. gift, urgent, exchange" value={tag} onChange={(e) => setTag(e.currentTarget.value)} data-autofocus />
          <Group justify="flex-end"><Button type="submit">{mode === "add_tag" ? "Add" : "Remove"}</Button></Group>
        </Stack>
      </form>
    </Modal>
  );
}
