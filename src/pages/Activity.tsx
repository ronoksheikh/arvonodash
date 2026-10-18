import { useState } from "react";
import { Badge, Group, ScrollArea, Select, Table, Text, Anchor } from "@mantine/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api, qs } from "../api";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel, TableFooter } from "../components/ui";
import { OrderDrawer } from "../components/OrderDrawer";
import { dateTime, titleCase } from "../format";
import type { Activity } from "../types";

const AREAS = [
  { value: "courier.", label: "Courier" },
  { value: "order.", label: "Orders" },
  { value: "orders.", label: "Bulk actions" },
  { value: "return.", label: "Returns" },
  { value: "customer.", label: "Customers" },
  { value: "settings.", label: "Settings" },
  { value: "user.", label: "Users" },
  { value: "auth.", label: "Sign-ins" },
  { value: "sync.", label: "Sync" },
];

export default function ActivityPage() {
  const [action, setAction] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [order, setOrder] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ["activity", action, page],
    queryFn: () => api<{ rows: Activity[]; total: number; pageSize: number }>(`/logs/activity${qs({ action, page })}`),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <PageHeader title="Activity log" description="Every staff action, courier update and automated change" />
      <Panel>
        <Group p="md"><Select placeholder="All areas" clearable data={AREAS} value={action} onChange={(v) => { setAction(v); setPage(1); }} w={200} /></Group>
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} /> : !q.data?.rows.length ? <EmptyState title="No activity" /> : (
          <>
            <ScrollArea>
              <Table className="app-table" verticalSpacing={8} miw={800}>
                <Table.Thead><Table.Tr><Table.Th pl="md">When</Table.Th><Table.Th>Who</Table.Th><Table.Th>Action</Table.Th><Table.Th>Target</Table.Th><Table.Th pr="md">Details</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {q.data.rows.map((a) => (
                    <Table.Tr key={a.id} style={{ cursor: "default" }}>
                      <Table.Td pl="md"><Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>{dateTime(a.createdAt)}</Text></Table.Td>
                      <Table.Td><Badge size="sm" variant={["system", "shopify", "steadfast"].includes(a.actor) ? "outline" : "light"} color={a.actor === "steadfast" ? "indigo" : a.actor === "shopify" ? "teal" : a.actor === "system" ? "gray" : "brand"}>{a.actor}</Badge></Table.Td>
                      <Table.Td><Text size="sm">{titleCase(a.action.replace(".", " · "))}</Text></Table.Td>
                      <Table.Td>{a.orderId ? <Anchor size="sm" onClick={() => setOrder(a.orderId)}>{a.orderName ?? `Order ${a.orderId}`}</Anchor> : <Text size="sm" c="dimmed">{a.entityId ?? "—"}</Text>}</Table.Td>
                      <Table.Td pr="md" maw={420}><Text size="xs" c="dimmed" className="mono" lineClamp={2}>{a.details ? JSON.stringify(a.details) : ""}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </ScrollArea>
            <TableFooter page={page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Panel>
      <OrderDrawer orderId={order} onClose={() => setOrder(null)} />
    </>
  );
}
