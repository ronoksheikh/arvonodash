import { useState } from "react";
import { Alert, Badge, Button, Card, Code, Group, Modal, NumberInput, Progress, ScrollArea, SimpleGrid, Stack, Table, Tabs, Text, ActionIcon, Tooltip } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, PackageSearch, Play, RefreshCw, RotateCcw, Truck, Wallet, Ban, Eye } from "lucide-react";
import { api, notifyError, notifySuccess, post, qs } from "../api";
import { useCan } from "../auth";
import { EmptyState, ErrorState, LoadingState, PageHeader, Panel } from "../components/ui";
import { ago, dateTime, titleCase } from "../format";

type SyncData = {
  runs: { id: number; kind: string; trigger: string; status: string; stats: Record<string, unknown> | null; error: string | null; startedAt: string; finishedAt: string | null }[];
  events: { id: number; provider: string; topic: string; status: string; attempts: number; error: string | null; receivedAt: string; processedAt: string | null }[];
  jobs: { id: number; type: string; key: string; status: string; attempts: number; maxAttempts: number; runAfter: string; lastError: string | null; updatedAt: string }[];
  importState: { done: boolean; imported: number; since: string | null; startedAt: string; finishedAt?: string } | null;
  webhookCounts: { provider: string; status: string; n: number }[];
};

const STATUS_COLOR: Record<string, string> = { success: "teal", processed: "teal", partial: "yellow", failed: "red", running: "blue", received: "blue", ignored: "gray", pending: "blue", done: "teal", cancelled: "gray" };

export default function Sync() {
  const can = useCan();
  const qc = useQueryClient();
  const [webhookStatus, setWebhookStatus] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [sinceDays, setSinceDays] = useState<number | string>(60);
  const [viewEvent, setViewEvent] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["sync", webhookStatus], queryFn: () => api<SyncData>(`/logs/sync${qs({ webhookStatus })}`), refetchInterval: 15_000 });
  const run = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => post<Record<string, unknown>>(path, body ?? {}),
    onSuccess: (r) => {
      notifySuccess(Object.entries(r).filter(([, v]) => typeof v !== "object").map(([k, v]) => `${titleCase(k)}: ${v}`).join(" · ") || "Done");
      qc.invalidateQueries({ queryKey: ["sync"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
    onError: (e) => notifyError(e),
  });
  const event = useQuery({ queryKey: ["webhook-event", viewEvent], queryFn: () => api<{ event: { payload: string; error: string | null } }>(`/logs/webhooks/${viewEvent}`), enabled: viewEvent !== null });

  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data!;
  const count = (provider: string, status: string) => d.webhookCounts.find((c) => c.provider === provider && c.status === status)?.n ?? 0;
  const failedHooks = count("shopify", "failed") + count("steadfast", "failed");

  const actions = [
    { label: "Reconcile Shopify", desc: "Fetch orders updated since the last check (runs hourly)", icon: RefreshCw, path: "/sync/reconcile" },
    { label: "Poll courier statuses", desc: "Check active parcels with the courier (runs every 5 min)", icon: Truck, path: "/sync/courier" },
    { label: "Sync settlements", desc: "Fetch Steadfast payments and match parcels (every 3 hours)", icon: Wallet, path: "/sync/payments" },
    { label: "Run background jobs", desc: "Shopify fulfillments and tags waiting to run", icon: Play, path: "/sync/jobs/run" },
    { label: "Retry failed webhooks", desc: `${failedHooks} failed in the last 2 days`, icon: RotateCcw, path: "/sync/webhooks/retry" },
  ];

  return (
    <>
      <PageHeader title="Sync & webhooks" description="Webhooks drive synchronization; the cron recovers anything missed" />
      {can("sync.manage") && (
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md" mb="lg">
          <Card padding="md">
            <Group gap={8}><Download size={16} /><Text fw={600} size="sm">Import Shopify orders</Text></Group>
            {d.importState ? (
              <>
                <Text size="xs" c="dimmed" mt={4}>{d.importState.done ? `Finished ${ago(d.importState.finishedAt)}` : "In progress — continues automatically every 5 minutes"} · {d.importState.imported} imported{d.importState.since ? ` since ${new Date(d.importState.since).toLocaleDateString()}` : ""}</Text>
                {!d.importState.done && <Progress value={100} animated mt="xs" size="sm" />}
              </>
            ) : <Text size="xs" c="dimmed" mt={4}>Bring in existing orders. New orders arrive via webhooks.</Text>}
            <Group gap="xs" mt="sm">
              <Button size="xs" onClick={() => setImportOpen(true)}>Start import</Button>
              {d.importState && !d.importState.done && <Button size="xs" variant="default" loading={run.isPending} onClick={() => run.mutate({ path: "/sync/import/continue" })}>Continue now</Button>}
            </Group>
          </Card>
          {actions.map((a) => (
            <Card key={a.path} padding="md">
              <Group gap={8}><a.icon size={16} /><Text fw={600} size="sm">{a.label}</Text></Group>
              <Text size="xs" c="dimmed" mt={4}>{a.desc}</Text>
              <Button size="xs" variant="default" mt="sm" loading={run.isPending && run.variables?.path === a.path} onClick={() => run.mutate({ path: a.path })}>Run now</Button>
            </Card>
          ))}
        </SimpleGrid>
      )}

      <Panel>
        <Tabs defaultValue="webhooks" px="md" pt={6}>
          <Tabs.List>
            <Tabs.Tab value="webhooks" rightSection={failedHooks ? <Badge size="xs" color="red">{failedHooks}</Badge> : null}>Webhook events</Tabs.Tab>
            <Tabs.Tab value="jobs" rightSection={d.jobs.length ? <Badge size="xs" variant="light">{d.jobs.length}</Badge> : null}>Background jobs</Tabs.Tab>
            <Tabs.Tab value="runs">Sync runs</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="webhooks" mx="-md">
            <Group p="md" gap="xs">
              {[null, "failed", "processed", "ignored"].map((s) => (
                <Button key={s ?? "all"} size="compact-sm" variant={webhookStatus === s ? "filled" : "default"} onClick={() => setWebhookStatus(s)}>{s ? titleCase(s) : "All"}</Button>
              ))}
              <Text size="xs" c="dimmed" ml="auto">Shopify: {count("shopify", "processed")} ok · Steadfast: {count("steadfast", "processed")} ok · Carrybee: {count("carrybee", "processed")} ok</Text>
            </Group>
            {d.events.length === 0 ? <EmptyState icon={<PackageSearch size={22} />} title="No webhook events" description="Register Shopify webhooks and set the courier webhook URLs in Settings." /> : (
              <ScrollArea>
                <Table className="app-table" verticalSpacing={8} miw={760}>
                  <Table.Thead><Table.Tr><Table.Th pl="md">Received</Table.Th><Table.Th>Source</Table.Th><Table.Th>Topic</Table.Th><Table.Th>Status</Table.Th><Table.Th>Error</Table.Th><Table.Th pr="md" /></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {d.events.map((e) => (
                      <Table.Tr key={e.id} style={{ cursor: "default" }}>
                        <Table.Td pl="md"><Text size="xs" c="dimmed">{dateTime(e.receivedAt)}</Text></Table.Td>
                        <Table.Td><Badge size="sm" variant="outline" color={e.provider === "shopify" ? "teal" : "indigo"}>{e.provider}</Badge></Table.Td>
                        <Table.Td><Text size="sm" className="mono">{e.topic}</Text></Table.Td>
                        <Table.Td><Badge size="sm" color={STATUS_COLOR[e.status]}>{e.status}</Badge>{e.attempts > 1 && <Text span size="xs" c="dimmed"> ×{e.attempts}</Text>}</Table.Td>
                        <Table.Td maw={320}><Text size="xs" c="red" lineClamp={2}>{e.error}</Text></Table.Td>
                        <Table.Td pr="md">
                          <Group gap={4} justify="flex-end" wrap="nowrap">
                            <Tooltip label="View payload"><ActionIcon size="sm" variant="subtle" onClick={() => setViewEvent(e.id)}><Eye size={14} /></ActionIcon></Tooltip>
                            {e.status === "failed" && can("sync.manage") && <Tooltip label="Retry"><ActionIcon size="sm" variant="subtle" onClick={() => run.mutate({ path: "/sync/webhooks/retry", body: { ids: [e.id] } })}><RotateCcw size={14} /></ActionIcon></Tooltip>}
                          </Group>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="jobs" mx="-md">
            {d.jobs.length === 0 ? <EmptyState title="No pending or failed jobs" /> : (
              <ScrollArea>
                <Table className="app-table" verticalSpacing={8} miw={760}>
                  <Table.Thead><Table.Tr><Table.Th pl="md">Job</Table.Th><Table.Th>Status</Table.Th><Table.Th>Attempts</Table.Th><Table.Th>Next run</Table.Th><Table.Th>Last error</Table.Th><Table.Th pr="md" /></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {d.jobs.map((j) => (
                      <Table.Tr key={j.id} style={{ cursor: "default" }}>
                        <Table.Td pl="md"><Text size="sm">{titleCase(j.type)}</Text><Text size="xs" c="dimmed" className="mono">{j.key}</Text></Table.Td>
                        <Table.Td><Badge size="sm" color={STATUS_COLOR[j.status]}>{j.status}</Badge></Table.Td>
                        <Table.Td>{j.attempts}/{j.maxAttempts}</Table.Td>
                        <Table.Td><Text size="xs" c="dimmed">{j.status === "pending" ? ago(j.runAfter) : "—"}</Text></Table.Td>
                        <Table.Td maw={340}><Text size="xs" c="red" lineClamp={2}>{j.lastError}</Text></Table.Td>
                        <Table.Td pr="md">
                          {can("sync.manage") && (
                            <Group gap={4} justify="flex-end" wrap="nowrap">
                              <Tooltip label="Retry now"><ActionIcon size="sm" variant="subtle" onClick={() => run.mutate({ path: `/sync/jobs/${j.id}/retry` })}><RotateCcw size={14} /></ActionIcon></Tooltip>
                              <Tooltip label="Cancel"><ActionIcon size="sm" variant="subtle" color="red" onClick={() => run.mutate({ path: `/sync/jobs/${j.id}/cancel` })}><Ban size={14} /></ActionIcon></Tooltip>
                            </Group>
                          )}
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Tabs.Panel>

          <Tabs.Panel value="runs" mx="-md">
            {d.runs.length === 0 ? <EmptyState title="No sync runs yet" /> : (
              <ScrollArea>
                <Table className="app-table" verticalSpacing={8} miw={760}>
                  <Table.Thead><Table.Tr><Table.Th pl="md">Started</Table.Th><Table.Th>Kind</Table.Th><Table.Th>Trigger</Table.Th><Table.Th>Status</Table.Th><Table.Th pr="md">Result</Table.Th></Table.Tr></Table.Thead>
                  <Table.Tbody>
                    {d.runs.map((r) => (
                      <Table.Tr key={r.id} style={{ cursor: "default" }}>
                        <Table.Td pl="md"><Text size="xs" c="dimmed">{dateTime(r.startedAt)}</Text></Table.Td>
                        <Table.Td><Text size="sm">{titleCase(r.kind)}</Text></Table.Td>
                        <Table.Td><Badge size="sm" variant="outline" color="gray">{r.trigger}</Badge></Table.Td>
                        <Table.Td><Badge size="sm" color={STATUS_COLOR[r.status]}>{r.status}</Badge></Table.Td>
                        <Table.Td pr="md" maw={420}><Text size="xs" c={r.error ? "red" : "dimmed"} className="mono" lineClamp={2}>{r.error ?? (r.stats ? JSON.stringify(r.stats) : "")}</Text></Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea>
            )}
          </Tabs.Panel>
        </Tabs>
      </Panel>

      <Modal opened={importOpen} onClose={() => setImportOpen(false)} title="Import Shopify orders">
        <Stack>
          <Text size="sm">Imports orders page by page (50 per page). Existing orders are updated, never duplicated. Large imports continue automatically in the background.</Text>
          <NumberInput label="Orders created in the last N days" description="Leave empty to import all orders (needs the read_all_orders scope beyond 60 days)" min={1} value={sinceDays} onChange={setSinceDays} />
          <Alert variant="light" color="gray">Imported orders are never booked with a courier. Booking is always manual.</Alert>
          <Group justify="flex-end">
            <Button loading={run.isPending} onClick={() => run.mutate({ path: "/sync/import/start", body: { sinceDays: sinceDays === "" ? null : Number(sinceDays) } }, { onSuccess: () => setImportOpen(false) })}>Start import</Button>
          </Group>
        </Stack>
      </Modal>

      <Modal opened={viewEvent !== null} onClose={() => setViewEvent(null)} title="Webhook payload" size="xl">
        {event.isLoading ? <LoadingState /> : event.data ? (
          <Stack>
            {event.data.event.error && <Alert color="red" variant="light">{event.data.event.error}</Alert>}
            <ScrollArea.Autosize mah={500}>
              <Code block>{(() => { try { return JSON.stringify(JSON.parse(event.data.event.payload), null, 2); } catch { return event.data.event.payload; } })()}</Code>
            </ScrollArea.Autosize>
          </Stack>
        ) : null}
      </Modal>
    </>
  );
}
