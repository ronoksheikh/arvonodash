import { useEffect, useMemo, useRef, useState } from "react";
import { notifications } from "@mantine/notifications";
import { Tooltip, ActionIcon, Anchor, Badge, Button, Checkbox, Group, Menu, Modal, ScrollArea, Select, Stack, Switch, Table, Tabs, Text, TextInput, Affix, Paper, Transition, Alert, List } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDebouncedValue } from "@mantine/hooks";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Package, PhoneCall, ArrowDownUp, Download, Filter, MoreHorizontal, Printer, Search, Send, Tag, X, CheckCircle2, ShieldAlert, XCircle, Archive, ShieldOff, ListChecks, Megaphone } from "lucide-react";
import { api, post, qs, notifyError, notifySuccess } from "../api";
import { useCan } from "../auth";
import { useBookingCourier } from "../courier";
import { AutoBookChip, CustomerHistoryBadge, CustomStatusBadge, EmptyState, ErrorState, LoadingState, PageHeader, Panel, RiskBadge, TableFooter, useStatuses } from "../components/ui";
import { CallingMenu } from "../components/Calling";
import { OrderDrawer } from "../components/OrderDrawer";
import { RiskPill } from "../components/Risk";
import { OrderProgress } from "../components/Progress";
import { channelInfo, SourceBadge } from "../components/Source";
import { dateShort, money } from "../format";
import { CALLING_STATUSES } from "../../shared/constants";
import type { OrderListRow } from "../types";

const TABS = [
  { value: "all", label: "All" },
  { value: "call_first", label: "Call first" },
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
type BookResult = { orderId: number; name?: string; ok: boolean; error?: string; trackingCode?: string; combinedWith?: string[] };
type BookRequest = { ids: number[]; allowRisky: boolean; combine: boolean };

export default function Orders() {
  const [params, setParams] = useSearchParams();
  const can = useCan();
  const courier = useBookingCourier();
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
    channel: params.get("channel"),
    campaign: params.get("campaign"),
    risk: params.get("risk"),
  };
  const sources = useQuery({
    queryKey: ["order-sources"],
    queryFn: () => api<{ channels: { channel: string; count: number }[]; campaigns: { campaign: string; channel: string; count: number }[] }>("/orders/sources"),
    staleTime: 300_000,
  });
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
    mutationFn: async ({ ids, allowRisky, combine }: BookRequest) => {
      // Send in batches of ~50, never splitting one customer's orders (they may share a parcel).
      const byPhone = new Map<string, number[]>();
      for (const id of ids) {
        const key = rows.find((r) => r.id === id)?.phone ?? `id:${id}`;
        byPhone.set(key, [...(byPhone.get(key) ?? []), id]);
      }
      const batches: number[][] = [[]];
      for (const group of byPhone.values()) {
        if (batches.at(-1)!.length + group.length > 50) batches.push([]);
        batches.at(-1)!.push(...group);
      }
      const all: BookResult[] = [];
      for (const batch of batches.filter((b) => b.length)) {
        const r = await post<{ results: BookResult[] }>("/orders/book", { ids: batch, allowRisky, combine });
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
        description="Shopify orders synced in real time. Confirmed orders are booked with the selected courier after a short timer (or manually)."
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
                style={{ flexShrink: 0 }}
                rightSection={
                  query.data?.tabCounts[t.value] !== undefined ? (
                    <Badge size="xs" variant={tab === t.value ? "filled" : "light"} color={t.value === "attention" && query.data.tabCounts[t.value] ? "orange" : t.value === "call_first" && query.data.tabCounts[t.value] ? "red" : tab === t.value ? "brand" : "gray"} style={{ flexShrink: 0, minWidth: 22, overflow: "visible", fontVariantNumeric: "tabular-nums" }}>
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
          <Select
            placeholder="Any source"
            leftSection={<Megaphone size={14} />}
            clearable
            searchable
            data={(sources.data?.channels ?? []).map((x) => ({ value: x.channel, label: `${channelInfo(x.channel).label} (${x.count})` }))}
            value={filters.channel}
            onChange={(v) => set({ channel: v, page: null })}
            w={190}
          />
          {(sources.data?.campaigns.length ?? 0) > 0 && (
            <Select
              placeholder="Any campaign"
              clearable
              searchable
              data={(sources.data?.campaigns ?? []).map((x) => ({ value: x.campaign, label: `${x.campaign} (${x.count})` }))}
              value={filters.campaign}
              onChange={(v) => set({ campaign: v, page: null })}
              w={210}
            />
          )}
          <Select
            placeholder="Any risk"
            leftSection={<ShieldAlert size={14} />}
            clearable
            data={[
              { value: "high", label: "Risky (60+)" },
              { value: "medium,high", label: "Check or risky (35+)" },
              { value: "medium", label: "Check (35–59)" },
              { value: "low", label: "Safe (0–34)" },
            ]}
            value={filters.risk}
            onChange={(v) => set({ risk: v, page: null })}
            w={190}
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
            description={filters.search || filters.statusId || filters.flagged || filters.channel || filters.campaign || filters.risk ? "Try clearing filters." : "Orders arrive automatically from Shopify webhooks. Import historical orders from Sync & webhooks."}
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
                    <Table.Th miw={130}>Source</Table.Th>
                    <Table.Th onClick={() => sortBy("customer")} style={{ cursor: "pointer" }}>Customer <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th onClick={() => sortBy("risk")} style={{ cursor: "pointer" }} miw={110}>Risk <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th ta="right" onClick={() => sortBy("total")} style={{ cursor: "pointer" }}>Total <ArrowDownUp size={11} /></Table.Th>
                    <Table.Th miw={260}>Status</Table.Th>
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
                      <Table.Td><SourceBadge channel={o.channel} campaign={o.utmCampaign} source={o.utmSource} medium={o.utmMedium} /></Table.Td>
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
                      <Table.Td><RiskPill risk={o.risk} /></Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={500} style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{money(o.total)}</Text>
                        <Text size="xs" c={o.financialStatus === "paid" ? "teal.7" : "dimmed"} style={{ whiteSpace: "nowrap" }}>
                          {o.financialStatus === "paid" ? "Prepaid" : o.outstanding > 0 ? (o.outstanding !== o.total ? `COD ${money(o.outstanding)}` : "COD") : (o.financialStatus ?? "")}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Group gap={6} wrap="nowrap" align="flex-start">
                          <div style={{ minWidth: 0 }}>
                            <OrderProgress
                              order={o}
                              first={o.courierStage === "unbooked" && !o.cancelledAt ? <CallingMenu orderId={o.id} status={o.callingStatus} onDone={invalidate} /> : undefined}
                            />
                          </div>
                          {tab === "to_call" && can("orders.call") && o.courierStage === "unbooked" && !o.cancelledAt && (
                            <Tooltip label="Confirmed">
                              <ActionIcon size="sm" color="teal" variant="light" aria-label="Confirm" loading={quickConfirm.isPending && quickConfirm.variables === o.id} onClick={(e) => { e.stopPropagation(); quickConfirm.mutate(o.id); }}>
                                <CheckCircle2 size={14} />
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </Group>
                        <Group gap={6} mt={2}>
                          {o.callAttempts > 0 && o.courierStage === "unbooked" && <Text size="xs" c="dimmed">{o.callAttempts} call{o.callAttempts === 1 ? "" : "s"}{o.callbackAt ? ` · callback ${dateShort(o.callbackAt)}` : ""}</Text>}
                          {o.trackingCode && <Text size="xs" c="dimmed" className="mono">{o.trackingCode}</Text>}
                        </Group>
                        {o.autoBookAt && o.courierStage === "unbooked" && <div style={{ marginTop: 4 }}><AutoBookChip at={o.autoBookAt} /></div>}
                        {!o.autoBookAt && o.autoBookNote && o.courierStage === "unbooked" && <Text size="xs" c="orange.7" maw={280}>{o.autoBookNote}</Text>}
                        {o.combinableWith && o.courierStage === "unbooked" && o.callingStatus === "confirmed" && !o.cancelledAt && (
                          <Tooltip label="Same customer has other confirmed orders. Book them together to send one parcel (one delivery charge).">
                            <Badge size="xs" variant="light" color="grape" mt={4} leftSection={<Package size={10} />}>One parcel with {o.combinableWith}</Badge>
                          </Tooltip>
                        )}
                        {o.combinedIntoOrderId && <Badge size="xs" variant="outline" color="grape" mt={4}>Combined parcel</Badge>}
                      </Table.Td>
                      <Table.Td pr="md">
                        <Group gap={4}>
                          {o.statusId && <CustomStatusBadge statusId={o.statusId} statuses={statuses.data} />}
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
                      Send to {courier.label}{bookable.length !== selected.size && bookable.length ? ` (${bookable.length})` : ""}
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

      <BookModal opened={bookOpen} onClose={() => setBookOpen(false)} rows={bookable} skipped={selected.size - bookable.length} loading={book.isPending} onConfirm={(req) => book.mutate(req)} />

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
                      <Table.Td>
                        {r.ok ? <Text size="sm" className="mono" c="teal">{r.trackingCode}</Text> : <Text size="sm" c="red">{r.error}</Text>}
                        {r.ok && r.combinedWith?.length ? <Text size="xs" c="dimmed">One parcel with {r.combinedWith.join(", ")}</Text> : null}
                      </Table.Td>
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

function BookModal({ opened, onClose, rows, skipped, loading, onConfirm }: { opened: boolean; onClose: () => void; rows: OrderListRow[]; skipped: number; loading: boolean; onConfirm: (req: BookRequest) => void }) {
  const courier = useBookingCourier();
  const [allowRisky, setAllowRisky] = useState(false);
  const [combine, setCombine] = useState(true);
  const [skipFraud, setSkipFraud] = useState(true);
  const risky = rows.filter((r) => r.fraud?.verdict === "risky");
  const toBook = skipFraud ? rows.filter((r) => r.fraud?.verdict !== "risky") : rows;
  // Same customer (phone) → one parcel when combining.
  const groups = useMemo(() => {
    const byPhone = new Map<string, OrderListRow[]>();
    for (const r of toBook) byPhone.set(r.phone ?? `id:${r.id}`, [...(byPhone.get(r.phone ?? `id:${r.id}`) ?? []), r]);
    return [...byPhone.values()];
  }, [toBook]);
  const combined = groups.filter((g) => g.length > 1);
  const parcels = combine ? groups.length : toBook.length;
  // "Same customer ordered again" is answered by sending the orders as one parcel.
  const combinedIds = new Set(combine ? combined.flat().map((r) => r.id) : []);
  const ignored = (r: OrderListRow, f: string) => f === "courier_fraud" || (combinedIds.has(r.id) && f.startsWith("duplicate_"));
  const flagged = toBook.filter((r) => r.riskFlags?.some((f) => !ignored(r, f)) && !r.riskDismissed);
  const noPhone = toBook.filter((r) => !r.phone);
  const cod = toBook.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={600}>Send to {courier.fullName}</Text>} size="lg">
      <Stack>
        <Group grow>
          <Paper withBorder p="sm" radius="md"><Text size="xs" c="dimmed">Orders</Text><Text fw={700} fz="xl">{toBook.length}</Text></Paper>
          <Paper withBorder p="sm" radius="md"><Text size="xs" c="dimmed">Parcels</Text><Text fw={700} fz="xl">{parcels}</Text></Paper>
          <Paper withBorder p="sm" radius="md"><Text size="xs" c="dimmed">Total COD</Text><Text fw={700} fz="xl">{money(cod)}</Text></Paper>
        </Group>
        {skipped > 0 && <Alert color="gray" variant="light">{skipped} selected order(s) are not confirmed, already booked or cancelled and will be skipped.</Alert>}
        {combined.length > 0 && (
          <Alert color="grape" variant="light" icon={<Package size={18} />} title={`${combined.length} customer(s) have more than one order`}>
            <Switch mt={4} label="Send each customer's orders as one parcel (one delivery charge, one return risk)" checked={combine} onChange={(e) => setCombine(e.currentTarget.checked)} />
            {combine && (
              <List size="sm" mt="xs">
                {combined.slice(0, 6).map((g) => (
                  <List.Item key={g[0].id}>{g.map((r) => r.name).join(" + ")} — {g[0].customerName} · COD {money(g.reduce((s, r) => s + Math.max(0, r.outstanding), 0))}</List.Item>
                ))}
              </List>
            )}
          </Alert>
        )}
        {risky.length > 0 && (
          <Alert color="red" variant="light" title={`${risky.length} customer(s) have a poor Steadfast record`}>
            <List size="sm">{risky.slice(0, 6).map((r) => <List.Item key={r.id}>{r.name} — {r.customerName} ({r.fraud?.reasons.join(", ")})</List.Item>)}</List>
            <Checkbox mt="xs" label="Leave them out — call them first" checked={skipFraud} onChange={(e) => setSkipFraud(e.currentTarget.checked)} />
          </Alert>
        )}
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
          <Button leftSection={<Send size={15} />} loading={loading} disabled={!toBook.length} onClick={() => onConfirm({ ids: toBook.map((r) => r.id), allowRisky, combine })}>
            Send {parcels} parcel{parcels === 1 ? "" : "s"}
          </Button>
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
