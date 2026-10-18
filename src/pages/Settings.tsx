import { useEffect, useState } from "react";
import {
  Alert, Badge, Button, Card, Checkbox, ColorSwatch, Group, Modal, NumberInput, PasswordInput, Radio, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, TextInput, ActionIcon, Code, Textarea, Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Plug, Plus, Trash2, XCircle, Webhook, Star } from "lucide-react";
import { api, del, notifyError, notifySuccess, patch, post, put } from "../api";
import { useAuth, useCan } from "../auth";
import { Copyable, ErrorState, LoadingState, PageHeader } from "../components/ui";
import { ago, money } from "../format";
import { FULFILLMENT_TRIGGERS, PERMISSIONS } from "../../shared/constants";
import type { CustomStatus } from "../types";

type AppSettings = {
  fulfillmentTrigger: keyof typeof FULFILLMENT_TRIGGERS;
  notifyCustomer: boolean;
  trackingCompany: string;
  invoicePrefix: string;
  defaultNote: string;
  includeItemsInDescription: boolean;
  shopifyBookedTag: string;
  highValueThreshold: number;
  duplicateWindowHours: number;
  autoCreateReturns: boolean;
  businessName: string;
  businessPhone: string;
  businessAddress: string;
};
type SettingsData = {
  settings: AppSettings;
  statuses: CustomStatus[];
  connections: {
    shopify: { configured: boolean; shopDomain: string; apiVersion: string; authMode: string; webhookSecret: boolean; webhookUrl: string };
    steadfast: { configured: boolean; baseUrl: string; webhookToken: boolean; webhookUrl: string };
  };
  sync: Record<string, unknown>;
};

export default function SettingsPage() {
  const can = useCan();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsData>("/settings") });
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <>
      <PageHeader title="Settings" description="Connections, workflow rules and staff" />
      <Tabs defaultValue="connections" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="connections">Connections</Tabs.Tab>
          <Tabs.Tab value="workflow">Workflow</Tabs.Tab>
          <Tabs.Tab value="statuses">Order statuses</Tabs.Tab>
          {can("users.manage") && <Tabs.Tab value="staff">Staff & permissions</Tabs.Tab>}
          <Tabs.Tab value="account">My account</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="connections"><Connections d={q.data!} /></Tabs.Panel>
        <Tabs.Panel value="workflow"><Workflow d={q.data!} /></Tabs.Panel>
        <Tabs.Panel value="statuses"><Statuses statuses={q.data!.statuses} /></Tabs.Panel>
        {can("users.manage") && <Tabs.Panel value="staff"><Staff /></Tabs.Panel>}
        <Tabs.Panel value="account"><Account /></Tabs.Panel>
      </Tabs>
    </>
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Group gap={6}>
      {ok ? <CheckCircle2 size={15} color="var(--mantine-color-teal-6)" /> : <XCircle size={15} color="var(--mantine-color-red-6)" />}
      <Text size="sm">{label}</Text>
    </Group>
  );
}

function Connections({ d }: { d: SettingsData }) {
  const can = useCan();
  const { shopify, steadfast } = d.connections;
  const testShopify = useMutation({ mutationFn: () => post<{ ok: boolean; error?: string; shop?: { name: string; currencyCode: string }; webhooks?: { topic: string; uri: string }[] }>("/settings/test/shopify") });
  const testSteadfast = useMutation({ mutationFn: () => post<{ ok: boolean; error?: string; balance?: number }>("/settings/test/steadfast") });
  const registerHooks = useMutation({
    mutationFn: () => post<{ results: { topic: string; status: string; message?: string }[] }>("/settings/shopify/webhooks"),
    onSuccess: (r) => notifySuccess(r.results.map((x) => `${x.topic}: ${x.status}${x.message ? ` (${x.message})` : ""}`).join(", "), "Shopify webhooks"),
    onError: (e) => notifyError(e),
  });
  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
      <Card>
        <Group justify="space-between" mb="md">
          <Text fw={600}>Shopify</Text>
          <Badge color={shopify.configured ? "teal" : "red"}>{shopify.configured ? "Configured" : "Not configured"}</Badge>
        </Group>
        <Stack gap="xs">
          <Status ok={shopify.configured} label={`Store ${shopify.shopDomain} · API ${shopify.apiVersion}`} />
          <Status ok={shopify.configured} label={shopify.authMode === "access_token" ? "Admin API access token" : "Client credentials (Dev Dashboard app)"} />
          <Status ok={shopify.webhookSecret} label="Webhook HMAC secret" />
          <Text size="sm" c="dimmed" mt="xs">Webhook endpoint</Text>
          <Copyable value={shopify.webhookUrl} />
          {testShopify.data && (
            testShopify.data.ok ? (
              <Alert color="teal" variant="light" mt="xs">
                Connected to <b>{testShopify.data.shop?.name}</b> ({testShopify.data.shop?.currencyCode}). Webhooks registered: {testShopify.data.webhooks?.length ? testShopify.data.webhooks.map((w) => w.topic).join(", ") : "none"}
              </Alert>
            ) : <Alert color="red" variant="light" mt="xs">{testShopify.data.error}</Alert>
          )}
          {can("settings.manage") && (
            <Group mt="sm" gap="xs">
              <Button variant="default" size="xs" leftSection={<Plug size={14} />} loading={testShopify.isPending} onClick={() => testShopify.mutate()}>Test connection</Button>
              <Button variant="default" size="xs" leftSection={<Webhook size={14} />} loading={registerHooks.isPending} onClick={() => registerHooks.mutate()}>Register webhooks</Button>
            </Group>
          )}
          <Text size="xs" c="dimmed" mt="xs">Credentials are Cloudflare Worker secrets (SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET) and are never sent to the browser.</Text>
        </Stack>
      </Card>
      <Card>
        <Group justify="space-between" mb="md">
          <Text fw={600}>Steadfast Courier</Text>
          <Badge color={steadfast.configured ? "teal" : "red"}>{steadfast.configured ? "Configured" : "Not configured"}</Badge>
        </Group>
        <Stack gap="xs">
          <Status ok={steadfast.configured} label={`API keys · ${steadfast.baseUrl}`} />
          <Status ok={steadfast.webhookToken} label="Webhook bearer token" />
          <Text size="sm" c="dimmed" mt="xs">Callback URL (paste into Steadfast panel → API → Webhook)</Text>
          <Copyable value={steadfast.webhookUrl} />
          <Text size="xs" c="dimmed">Use the value of the STEADFAST_WEBHOOK_TOKEN secret as the “Auth Token (Bearer)”.</Text>
          {testSteadfast.data && (testSteadfast.data.ok ? <Alert color="teal" variant="light" mt="xs">Connected. Current balance {money(testSteadfast.data.balance, true)}</Alert> : <Alert color="red" variant="light" mt="xs">{testSteadfast.data.error}</Alert>)}
          {can("settings.manage") && <Button variant="default" size="xs" w="fit-content" mt="sm" leftSection={<Plug size={14} />} loading={testSteadfast.isPending} onClick={() => testSteadfast.mutate()}>Test connection</Button>}
        </Stack>
      </Card>
      <Card style={{ gridColumn: "1 / -1" }}>
        <Text fw={600} mb="xs">Background sync</Text>
        <Text size="sm" c="dimmed">Cron last ran {d.sync["cron.lastRun"] ? ago(d.sync["cron.lastRun"] as string) : "never (deploy to enable the every-5-minute schedule)"}. Shopify reconciliation watermark: <Code>{String(d.sync["shopify.reconcileWatermark"] ?? "not started")}</Code></Text>
      </Card>
    </SimpleGrid>
  );
}

function Workflow({ d }: { d: SettingsData }) {
  const can = useCan();
  const qc = useQueryClient();
  const [s, setS] = useState(d.settings);
  useEffect(() => setS(d.settings), [d.settings]);
  const save = useMutation({
    mutationFn: () => put("/settings", s),
    onSuccess: () => { notifySuccess("Settings saved"); qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e) => notifyError(e),
  });
  const disabled = !can("settings.manage");
  return (
    <Stack maw={820}>
      <Card>
        <Text fw={600} mb={4}>Automatic Shopify fulfillment</Text>
        <Text size="sm" c="dimmed" mb="md">When should a booked order be marked fulfilled in Shopify (with Steadfast tracking)? Courier delivery status is always tracked separately.</Text>
        <Radio.Group value={s.fulfillmentTrigger} onChange={(v) => setS({ ...s, fulfillmentTrigger: v as AppSettings["fulfillmentTrigger"] })}>
          <Stack gap="xs">
            {Object.entries(FULFILLMENT_TRIGGERS).map(([value, label]) => <Radio key={value} value={value} label={label} disabled={disabled} />)}
          </Stack>
        </Radio.Group>
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="md">
          <TextInput label="Tracking company name" description="Shown to customers in Shopify" value={s.trackingCompany} onChange={(e) => setS({ ...s, trackingCompany: e.currentTarget.value })} disabled={disabled} />
          <Switch mt={30} label="Send Shopify shipping confirmation to customer" checked={s.notifyCustomer} onChange={(e) => setS({ ...s, notifyCustomer: e.currentTarget.checked })} disabled={disabled} />
        </SimpleGrid>
      </Card>
      <Card>
        <Text fw={600} mb="md">Booking defaults</Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Invoice prefix" description="Invoice = prefix + order number, e.g. ARV-1001" value={s.invoicePrefix} onChange={(e) => setS({ ...s, invoicePrefix: e.currentTarget.value.replace(/[^A-Za-z0-9_-]/g, "") })} disabled={disabled} />
          <TextInput label="Tag Shopify order when booked" description="Leave empty to skip" value={s.shopifyBookedTag} onChange={(e) => setS({ ...s, shopifyBookedTag: e.currentTarget.value })} disabled={disabled} />
        </SimpleGrid>
        <Textarea mt="sm" label="Default rider note" autosize minRows={2} value={s.defaultNote} onChange={(e) => setS({ ...s, defaultNote: e.currentTarget.value })} disabled={disabled} />
        <Checkbox mt="sm" label="Include item list in the Steadfast item description" checked={s.includeItemsInDescription} onChange={(e) => setS({ ...s, includeItemsInDescription: e.currentTarget.checked })} disabled={disabled} />
      </Card>
      <Card>
        <Text fw={600} mb="md">Risk & duplicate detection</Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput label="High-value COD threshold (৳)" min={0} thousandSeparator="," value={s.highValueThreshold} onChange={(v) => setS({ ...s, highValueThreshold: Number(v) || 0 })} disabled={disabled} />
          <NumberInput label="Duplicate window (hours)" min={1} max={720} value={s.duplicateWindowHours} onChange={(v) => setS({ ...s, duplicateWindowHours: Number(v) || 72 })} disabled={disabled} />
        </SimpleGrid>
        <Checkbox mt="md" label="Create a return record automatically when a parcel is returned or partially delivered" checked={s.autoCreateReturns} onChange={(e) => setS({ ...s, autoCreateReturns: e.currentTarget.checked })} disabled={disabled} />
      </Card>
      <Card>
        <Text fw={600} mb="md">Business details (labels & packing slips)</Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Business name" value={s.businessName} onChange={(e) => setS({ ...s, businessName: e.currentTarget.value })} disabled={disabled} />
          <TextInput label="Phone" value={s.businessPhone} onChange={(e) => setS({ ...s, businessPhone: e.currentTarget.value })} disabled={disabled} />
        </SimpleGrid>
        <Textarea mt="sm" label="Return address" autosize minRows={2} value={s.businessAddress} onChange={(e) => setS({ ...s, businessAddress: e.currentTarget.value })} disabled={disabled} />
      </Card>
      {!disabled && <Group justify="flex-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button></Group>}
    </Stack>
  );
}

const COLORS = ["gray", "blue", "teal", "green", "lime", "yellow", "orange", "red", "pink", "grape", "violet", "indigo", "cyan"];

function Statuses({ statuses }: { statuses: CustomStatus[] }) {
  const can = useCan();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState("blue");
  const refresh = () => { qc.invalidateQueries({ queryKey: ["settings"] }); qc.invalidateQueries({ queryKey: ["statuses"] }); };
  const add = useMutation({ mutationFn: () => post("/settings/statuses", { name, color }), onSuccess: () => { setName(""); refresh(); }, onError: (e) => notifyError(e) });
  const upd = useMutation({ mutationFn: ({ id, body }: { id: number; body: Partial<CustomStatus> }) => patch(`/settings/statuses/${id}`, body), onSuccess: refresh, onError: (e) => notifyError(e) });
  const remove = useMutation({ mutationFn: (id: number) => del(`/settings/statuses/${id}`), onSuccess: refresh, onError: (e) => notifyError(e) });
  const disabled = !can("settings.manage");
  return (
    <Card maw={820} padding={0}>
      <Text size="sm" c="dimmed" p="md">Custom statuses track your own workflow (e.g. phone confirmation) independently of Shopify and courier status. Statuses that block booking prevent sending orders to Steadfast.</Text>
      <Table className="app-table" verticalSpacing={8}>
        <Table.Thead><Table.Tr><Table.Th pl="md">Status</Table.Th><Table.Th>Color</Table.Th><Table.Th>Default for new orders</Table.Th><Table.Th>Blocks booking</Table.Th><Table.Th pr="md" /></Table.Tr></Table.Thead>
        <Table.Tbody>
          {statuses.map((s) => (
            <Table.Tr key={s.id} style={{ cursor: "default" }}>
              <Table.Td pl="md"><Badge color={s.color}>{s.name}</Badge></Table.Td>
              <Table.Td>
                <Select size="xs" w={110} data={COLORS} value={s.color} onChange={(v) => v && upd.mutate({ id: s.id, body: { color: v } })} disabled={disabled} leftSection={<ColorSwatch size={12} color={`var(--mantine-color-${s.color}-6)`} />} />
              </Table.Td>
              <Table.Td>
                {s.isDefault ? <Badge size="sm" leftSection={<Star size={10} />}>Default</Badge> : !disabled && <Button size="compact-xs" variant="subtle" onClick={() => upd.mutate({ id: s.id, body: { isDefault: true } })}>Make default</Button>}
              </Table.Td>
              <Table.Td><Switch size="sm" checked={s.blocksBooking} onChange={(e) => upd.mutate({ id: s.id, body: { blocksBooking: e.currentTarget.checked } })} disabled={disabled} /></Table.Td>
              <Table.Td pr="md" ta="right">{!disabled && <Tooltip label="Delete"><ActionIcon variant="subtle" color="red" onClick={() => remove.mutate(s.id)}><Trash2 size={14} /></ActionIcon></Tooltip>}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {!disabled && (
        <Group p="md" style={{ borderTop: "1px solid var(--app-border)" }}>
          <TextInput placeholder="New status name" value={name} onChange={(e) => setName(e.currentTarget.value)} style={{ flex: 1 }} />
          <Select w={120} data={COLORS} value={color} onChange={(v) => setColor(v ?? "blue")} />
          <Button leftSection={<Plus size={14} />} disabled={!name.trim()} loading={add.isPending} onClick={() => add.mutate()}>Add</Button>
        </Group>
      )}
    </Card>
  );
}

type StaffUser = { id: number; email: string; name: string; role: string; permissions: string[] | null; active: boolean; lastLoginAt: string | null };

function Staff() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: StaffUser[]; roles: string[]; rolePermissions: Record<string, string[]> }>("/users") });
  const [editing, setEditing] = useState<Partial<StaffUser> & { password?: string; custom?: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: editing!.name, email: editing!.email, role: editing!.role, permissions: editing!.custom ? editing!.permissions : null, password: editing!.password || undefined, active: editing!.active };
      return editing!.id ? patch(`/users/${editing!.id}`, body) : post("/users", body);
    },
    onSuccess: () => { notifySuccess("Staff account saved"); setEditing(null); qc.invalidateQueries({ queryKey: ["users"] }); },
    onError: (e) => notifyError(e),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const { users, roles, rolePermissions } = q.data!;
  const effective = editing ? (editing.custom ? editing.permissions ?? [] : rolePermissions[editing.role ?? "operator"] ?? []) : [];
  return (
    <>
      <Card padding={0} maw={980}>
        <Group justify="space-between" p="md">
          <Text size="sm" c="dimmed">Roles set default permissions; you can customise per person.</Text>
          <Button size="xs" leftSection={<Plus size={14} />} onClick={() => setEditing({ role: "operator", active: true, permissions: null })}>Add staff</Button>
        </Group>
        <Table className="app-table" verticalSpacing={10}>
          <Table.Thead><Table.Tr><Table.Th pl="md">Name</Table.Th><Table.Th>Role</Table.Th><Table.Th>Permissions</Table.Th><Table.Th>Last sign-in</Table.Th><Table.Th pr="md">Status</Table.Th></Table.Tr></Table.Thead>
          <Table.Tbody>
            {users.map((u) => (
              <Table.Tr key={u.id} onClick={() => setEditing({ ...u, custom: Boolean(u.permissions) })}>
                <Table.Td pl="md"><Text size="sm" fw={500}>{u.name}</Text><Text size="xs" c="dimmed">{u.email}</Text></Table.Td>
                <Table.Td><Badge variant="light" tt="capitalize">{u.role}</Badge></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">{u.role === "owner" ? "Everything" : u.permissions ? `Custom (${u.permissions.length})` : "Role default"}</Text></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">{ago(u.lastLoginAt)}</Text></Table.Td>
                <Table.Td pr="md"><Badge color={u.active ? "teal" : "gray"} size="sm">{u.active ? "Active" : "Disabled"}</Badge></Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={editing?.id ? "Edit staff account" : "Add staff account"} size="lg">
        {editing && (
          <Stack>
            <SimpleGrid cols={2}>
              <TextInput label="Name" value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.currentTarget.value })} />
              <TextInput label="Email" value={editing.email ?? ""} disabled={Boolean(editing.id)} onChange={(e) => setEditing({ ...editing, email: e.currentTarget.value })} />
            </SimpleGrid>
            <SimpleGrid cols={2}>
              <Select label="Role" data={roles.filter((r) => r !== "owner" || editing.role === "owner").map((r) => ({ value: r, label: r[0].toUpperCase() + r.slice(1) }))} value={editing.role} disabled={editing.role === "owner"} onChange={(v) => setEditing({ ...editing, role: v ?? "operator" })} />
              <PasswordInput label={editing.id ? "New password" : "Password"} description={editing.id ? "Leave empty to keep" : "At least 10 characters"} value={editing.password ?? ""} onChange={(e) => setEditing({ ...editing, password: e.currentTarget.value })} />
            </SimpleGrid>
            {editing.role !== "owner" && (
              <>
                <Switch label="Customise permissions" checked={Boolean(editing.custom)} onChange={(e) => setEditing({ ...editing, custom: e.currentTarget.checked, permissions: e.currentTarget.checked ? rolePermissions[editing.role ?? "operator"] : null })} />
                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing={6}>
                  {Object.entries(PERMISSIONS).map(([p, label]) => (
                    <Checkbox
                      key={p}
                      size="sm"
                      label={label}
                      checked={effective.includes(p)}
                      disabled={!editing.custom}
                      onChange={(e) => setEditing({ ...editing, permissions: e.currentTarget.checked ? [...effective, p] : effective.filter((x) => x !== p) })}
                    />
                  ))}
                </SimpleGrid>
                {editing.id && <Switch label="Account active" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.currentTarget.checked })} />}
              </>
            )}
            <Group justify="flex-end"><Button loading={save.isPending} onClick={() => save.mutate()}>Save</Button></Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}

function Account() {
  const { user } = useAuth();
  return (
    <Card maw={520}>
      <Stack gap={4}>
        <Text fw={600}>{user?.name}</Text>
        <Text size="sm" c="dimmed">{user?.email} · {user?.role}</Text>
        <Text size="sm" mt="sm">Permissions</Text>
        <Group gap={4}>{user?.permissions.map((p) => <Badge key={p} size="sm" variant="outline" color="gray">{p}</Badge>)}</Group>
        <Text size="xs" c="dimmed" mt="md">To change your password, ask an owner to set a new one from Staff & permissions{user?.role === "owner" ? " (or edit your own entry there)" : ""}.</Text>
      </Stack>
    </Card>
  );
}
