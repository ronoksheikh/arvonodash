import { useEffect, useState } from "react";
import {
  Alert, Badge, Button, Card, SegmentedControl, Checkbox, ColorSwatch, Group, Modal, NumberInput, PasswordInput, Radio, Select, SimpleGrid, Stack, Switch, Table, Tabs, Text, TextInput, ActionIcon, Code, Textarea, Tooltip,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { modals } from "@mantine/modals";
import { CheckCircle2, XCircle, Plug, Plus, Trash2, Webhook, Star } from "lucide-react";
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
  autoBookEnabled: boolean;
  autoBookDelayMinutes: number;
  autoBookSkipFlagged: boolean;
  businessName: string;
  businessPhone: string;
  businessAddress: string;
};
type SettingsData = {
  settings: AppSettings;
  credentials: Record<string, CredInfo> | null;
  steadfastWebhookToken: string | null;
  encryptedAtRest: boolean;
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
          <Tabs.Tab value="statuses">Internal labels</Tabs.Tab>
          {can("users.manage") && <Tabs.Tab value="staff">Staff & permissions</Tabs.Tab>}
          {can("settings.manage") && <Tabs.Tab value="api">API keys</Tabs.Tab>}
          <Tabs.Tab value="account">My account</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="connections"><Connections d={q.data!} /></Tabs.Panel>
        <Tabs.Panel value="workflow"><Workflow d={q.data!} /></Tabs.Panel>
        <Tabs.Panel value="statuses"><Statuses statuses={q.data!.statuses} /></Tabs.Panel>
        {can("users.manage") && <Tabs.Panel value="staff"><Staff /></Tabs.Panel>}
        {can("settings.manage") && <Tabs.Panel value="api"><ApiKeys /></Tabs.Panel>}
        <Tabs.Panel value="account"><Account /></Tabs.Panel>
      </Tabs>
    </>
  );
}


type CredInfo = { set: boolean; source: "worker_secret" | "dashboard" | null; hint: string | null };

function CredentialField({ name, label, description, info, secret, value, onChange, disabled, onClear }: {
  name: string; label: string; description?: string; info?: CredInfo; secret?: boolean; value: string; onChange: (v: string) => void; disabled?: boolean; onClear?: () => void;
}) {
  const fromSecret = info?.source === "worker_secret";
  const placeholder = info?.set ? `${info.hint ?? "Saved"} — leave empty to keep` : undefined;
  const props = {
    label,
    description: fromSecret ? "Set as a Cloudflare Worker secret (overrides this field)" : description,
    placeholder,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.currentTarget.value),
    disabled: disabled || fromSecret,
    autoComplete: "off",
    name,
    rightSection: info?.set && !secret ? <CheckCircle2 size={15} color="var(--mantine-color-teal-6)" /> : undefined,
  };
  const field = secret ? <PasswordInput {...props} /> : <TextInput {...props} />;
  const canClear = onClear && info?.set && info.source === "dashboard" && !disabled;
  return (
    <div>
      {field}
      {canClear && (
        <Button size="compact-xs" variant="subtle" color="red" mt={4} onClick={() => modals.openConfirmModal({
          title: `Remove ${label}?`,
          children: <Text size="sm">The saved value is deleted. The connection stops working until a new value is saved.</Text>,
          labels: { confirm: "Remove", cancel: "Cancel" },
          confirmProps: { color: "red" },
          onConfirm: onClear,
        })}>
          Remove saved {label.toLowerCase()}
        </Button>
      )}
    </div>
  );
}

function Connections({ d }: { d: SettingsData }) {
  const can = useCan();
  const qc = useQueryClient();
  const { shopify, steadfast } = d.connections;
  const creds = d.credentials;
  const [form, setForm] = useState<Record<string, string>>({});
  const [authMode, setAuthMode] = useState<string>(creds?.SHOPIFY_ACCESS_TOKEN.set ? "token" : "client");
  const set = (k: string) => (v: string) => setForm({ ...form, [k]: v });
  const disabled = !can("settings.manage");
  const testShopify = useMutation({ mutationFn: () => post<{ ok: boolean; error?: string; shop?: { name: string; currencyCode: string }; webhooks?: { topic: string; uri: string }[]; steps?: { step: string; ok: boolean; detail: string }[] }>("/settings/test/shopify") });
  const testSteadfast = useMutation({ mutationFn: () => post<{ ok: boolean; error?: string; balance?: number }>("/settings/test/steadfast") });
  const save = useMutation({
    mutationFn: (body: Record<string, string | null>) => put("/settings/connections", body),
    onSuccess: () => {
      setForm({});
      notifySuccess("Connection details saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
      testShopify.reset();
      testSteadfast.reset();
    },
    onError: (e) => notifyError(e, "Could not save"),
  });
  const regenerate = useMutation({
    mutationFn: () => post("/settings/connections/regenerate-webhook-token"),
    onSuccess: () => { notifySuccess("New token generated — update it in the Steadfast panel"); qc.invalidateQueries({ queryKey: ["settings"] }); },
    onError: (e) => notifyError(e),
  });
  const registerHooks = useMutation({
    mutationFn: () => post<{ results: { topic: string; status: string; message?: string }[] }>("/settings/shopify/webhooks"),
    onSuccess: (r) => notifySuccess(r.results.map((x) => `${x.topic}: ${x.status}${x.message ? ` (${x.message})` : ""}`).join(", "), "Shopify webhooks"),
    onError: (e) => notifyError(e),
  });
  const saveSection = (keys: string[], clear: string[] = []) => {
    const body: Record<string, string | null> = {};
    for (const k of keys) if (form[k]?.trim()) body[k] = form[k].trim();
    for (const k of clear) body[k] = null;
    save.mutate(body);
  };
  const dirty = (keys: string[]) => keys.some((k) => form[k]?.trim());
  const clear = (k: string) => () => save.mutate({ [k]: null });
  // Switching to client credentials must drop a saved access token, which would otherwise take precedence.
  const staleToken = authMode === "client" && creds?.SHOPIFY_ACCESS_TOKEN.source === "dashboard";
  const shopifyKeys = ["SHOPIFY_SHOP_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_WEBHOOK_SECRET"];
  const steadfastKeys = ["STEADFAST_API_KEY", "STEADFAST_SECRET_KEY"];

  return (
    <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="md">
      <Card>
        <Group justify="space-between" mb="md">
          <Text fw={600}>Shopify</Text>
          <Badge color={shopify.configured ? "teal" : "red"}>{shopify.configured ? "Configured" : "Not configured"}</Badge>
        </Group>
        <Stack gap="sm">
          <CredentialField name="shop" label="Store domain" description="Permanent domain, e.g. arvono.myshopify.com" info={creds?.SHOPIFY_SHOP_DOMAIN} value={form.SHOPIFY_SHOP_DOMAIN ?? ""} onChange={set("SHOPIFY_SHOP_DOMAIN")} disabled={disabled} />
          <SegmentedControl
            size="xs"
            value={authMode}
            onChange={setAuthMode}
            data={[{ value: "client", label: "Dev Dashboard app (Client ID + secret)" }, { value: "token", label: "Admin API access token" }]}
            disabled={disabled}
          />
          {authMode === "client" ? (
            <>
              <CredentialField name="client_id" label="Client ID" info={creds?.SHOPIFY_CLIENT_ID} value={form.SHOPIFY_CLIENT_ID ?? ""} onChange={set("SHOPIFY_CLIENT_ID")} disabled={disabled} onClear={clear("SHOPIFY_CLIENT_ID")} />
              <CredentialField name="client_secret" label="Client secret" description="Also used to verify webhook signatures" secret info={creds?.SHOPIFY_CLIENT_SECRET} value={form.SHOPIFY_CLIENT_SECRET ?? ""} onChange={set("SHOPIFY_CLIENT_SECRET")} disabled={disabled} onClear={clear("SHOPIFY_CLIENT_SECRET")} />
            </>
          ) : (
            <>
              <CredentialField name="access_token" label="Admin API access token" description="shpat_… from a legacy custom app" secret info={creds?.SHOPIFY_ACCESS_TOKEN} value={form.SHOPIFY_ACCESS_TOKEN ?? ""} onChange={set("SHOPIFY_ACCESS_TOKEN")} disabled={disabled} onClear={clear("SHOPIFY_ACCESS_TOKEN")} />
              <CredentialField name="webhook_secret" label="Webhook signing secret" description="Shown in Shopify admin → Notifications → Webhooks" secret info={creds?.SHOPIFY_WEBHOOK_SECRET} value={form.SHOPIFY_WEBHOOK_SECRET ?? ""} onChange={set("SHOPIFY_WEBHOOK_SECRET")} disabled={disabled} onClear={clear("SHOPIFY_WEBHOOK_SECRET")} />
            </>
          )}
          <Text size="sm" c="dimmed">Webhook endpoint (registered automatically)</Text>
          <Copyable value={shopify.webhookUrl} />
          {testShopify.data && (
            testShopify.data.ok ? (
              <Alert color="teal" variant="light">
                Connected to <b>{testShopify.data.shop?.name}</b> ({testShopify.data.shop?.currencyCode}). Webhooks: {testShopify.data.webhooks?.length ? testShopify.data.webhooks.map((w) => w.topic).join(", ") : "none registered yet"}
              </Alert>
            ) : (
              <Alert color="red" variant="light" title="Connection failed">
                <Stack gap={6}>
                  {(testShopify.data.steps ?? [{ step: "Error", ok: false, detail: testShopify.data.error ?? "" }]).map((st) => (
                    <Group key={st.step} gap={6} wrap="nowrap" align="flex-start">
                      {st.ok ? <CheckCircle2 size={14} color="var(--mantine-color-teal-6)" style={{ flexShrink: 0, marginTop: 3 }} /> : <XCircle size={14} color="var(--mantine-color-red-6)" style={{ flexShrink: 0, marginTop: 3 }} />}
                      <Text size="sm"><b>{st.step}:</b> <span style={{ wordBreak: "break-word" }}>{st.detail}</span></Text>
                    </Group>
                  ))}
                </Stack>
              </Alert>
            )
          )}
          {staleToken && <Alert color="orange" variant="light">A saved Admin API access token is still active and overrides the Client ID/secret. Click Save to remove it.</Alert>}
          {!disabled && (
            <Group gap="xs">
              <Button size="xs" disabled={!dirty(shopifyKeys) && !staleToken} loading={save.isPending} onClick={() => saveSection(shopifyKeys, staleToken ? ["SHOPIFY_ACCESS_TOKEN"] : [])}>Save</Button>
              <Button variant="default" size="xs" leftSection={<Plug size={14} />} disabled={!shopify.configured} loading={testShopify.isPending} onClick={() => testShopify.mutate()}>Test connection</Button>
              <Button variant="default" size="xs" leftSection={<Webhook size={14} />} disabled={!shopify.configured} loading={registerHooks.isPending} onClick={() => registerHooks.mutate()}>Register webhooks</Button>
            </Group>
          )}
        </Stack>
      </Card>
      <Card>
        <Group justify="space-between" mb="md">
          <Text fw={600}>Steadfast Courier</Text>
          <Badge color={steadfast.configured ? "teal" : "red"}>{steadfast.configured ? "Configured" : "Not configured"}</Badge>
        </Group>
        <Stack gap="sm">
          <CredentialField name="sf_key" label="API key" description="Steadfast panel → API" secret info={creds?.STEADFAST_API_KEY} value={form.STEADFAST_API_KEY ?? ""} onChange={set("STEADFAST_API_KEY")} disabled={disabled} onClear={clear("STEADFAST_API_KEY")} />
          <CredentialField name="sf_secret" label="Secret key" secret info={creds?.STEADFAST_SECRET_KEY} value={form.STEADFAST_SECRET_KEY ?? ""} onChange={set("STEADFAST_SECRET_KEY")} disabled={disabled} onClear={clear("STEADFAST_SECRET_KEY")} />
          {testSteadfast.data && (testSteadfast.data.ok ? <Alert color="teal" variant="light">Connected. Current balance {money(testSteadfast.data.balance, true)}</Alert> : <Alert color="red" variant="light">{testSteadfast.data.error}</Alert>)}
          {!disabled && (
            <Group gap="xs">
              <Button size="xs" disabled={!dirty(steadfastKeys)} loading={save.isPending} onClick={() => saveSection(steadfastKeys)}>Save</Button>
              <Button variant="default" size="xs" leftSection={<Plug size={14} />} disabled={!steadfast.configured} loading={testSteadfast.isPending} onClick={() => testSteadfast.mutate()}>Test connection</Button>
            </Group>
          )}
          <Text fw={500} size="sm" mt="sm">Webhook — paste both into Steadfast panel → API → Webhook</Text>
          <Text size="xs" c="dimmed">Callback URL</Text>
          <Copyable value={steadfast.webhookUrl} />
          <Text size="xs" c="dimmed">Auth Token (Bearer)</Text>
          {d.steadfastWebhookToken ? <Copyable value={d.steadfastWebhookToken} /> : <Text size="sm" c="dimmed">Hidden</Text>}
          {!disabled && creds?.STEADFAST_WEBHOOK_TOKEN.source !== "worker_secret" && (
            <>
              <Group gap="xs" align="flex-end">
                <TextInput
                  size="xs"
                  style={{ flex: 1 }}
                  label="Use your own token"
                  description="At least 16 characters. The same value must be entered in the Steadfast panel."
                  value={form.STEADFAST_WEBHOOK_TOKEN ?? ""}
                  onChange={(e) => set("STEADFAST_WEBHOOK_TOKEN")(e.currentTarget.value)}
                  autoComplete="off"
                />
                <Button size="xs" disabled={(form.STEADFAST_WEBHOOK_TOKEN?.trim().length ?? 0) < 16} loading={save.isPending} onClick={() => saveSection(["STEADFAST_WEBHOOK_TOKEN"])}>Save token</Button>
              </Group>
              <Button size="compact-xs" variant="subtle" color="red" w="fit-content" loading={regenerate.isPending} onClick={() => modals.openConfirmModal({
                title: "Generate a new webhook token?",
                children: <Text size="sm">Steadfast webhooks will be rejected until you paste the new token into the Steadfast panel. The cron keeps polling statuses meanwhile.</Text>,
                labels: { confirm: "Generate", cancel: "Cancel" },
                confirmProps: { color: "red" },
                onConfirm: () => regenerate.mutate(),
              })}>Generate new random token</Button>
            </>
          )}
        </Stack>
      </Card>
      <Card style={{ gridColumn: "1 / -1" }}>
        <Text fw={600} mb="xs">Security & background sync</Text>
        <Text size="sm" c="dimmed">
          Credentials are stored server-side in D1 and never sent to the browser (only masked hints). {d.encryptedAtRest ? "They are encrypted at rest with APP_ENCRYPTION_KEY." : "Optional: set the APP_ENCRYPTION_KEY Worker secret before saving to encrypt them at rest."}
        </Text>
        <Text size="sm" c="dimmed" mt="xs">Cron last ran {d.sync["cron.lastRun"] ? ago(d.sync["cron.lastRun"] as string) : "never (runs every 5 minutes once deployed)"}. Shopify reconciliation watermark: <Code>{String(d.sync["shopify.reconcileWatermark"] ?? "not started")}</Code></Text>
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
        <Text fw={600} mb={4}>Auto-booking after confirmation</Text>
        <Text size="sm" c="dimmed" mb="md">When an order is confirmed (here or by marking it In progress in Shopify), it is booked with Steadfast after this delay. Staff can cancel the timer or book immediately from the order.</Text>
        <Switch label="Book confirmed orders automatically" checked={s.autoBookEnabled} onChange={(e) => setS({ ...s, autoBookEnabled: e.currentTarget.checked })} disabled={disabled} />
        <SimpleGrid cols={{ base: 1, sm: 2 }} mt="sm">
          <NumberInput label="Delay (minutes)" min={0} max={1440} value={s.autoBookDelayMinutes} onChange={(v) => setS({ ...s, autoBookDelayMinutes: Number(v) || 0 })} disabled={disabled || !s.autoBookEnabled} />
          <Switch mt={30} label="Skip orders with risk flags (book them manually)" checked={s.autoBookSkipFlagged} onChange={(e) => setS({ ...s, autoBookSkipFlagged: e.currentTarget.checked })} disabled={disabled || !s.autoBookEnabled} />
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
      <Text size="sm" c="dimmed" p="md">Optional internal labels (e.g. Hold, Priority, Exchange), separate from the calling status, Shopify status and courier status. Labels that block booking prevent sending orders to Steadfast.</Text>
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

type ApiKey = { id: number; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };

function ApiKeys() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["api-keys"], queryFn: () => api<{ keys: ApiKey[]; scopes: Record<string, string> }>("/settings/api-keys") });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("Label printing service");
  const [scopes, setScopes] = useState<string[]>(["dispatch:read", "dispatch:print"]);
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => post<{ key: string }>("/settings/api-keys", { name, scopes }),
    onSuccess: (r) => { setCreated(r.key); qc.invalidateQueries({ queryKey: ["api-keys"] }); },
    onError: (e) => notifyError(e),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => post(`/settings/api-keys/${id}/revoke`),
    onSuccess: () => { notifySuccess("Key revoked"); qc.invalidateQueries({ queryKey: ["api-keys"] }); },
    onError: (e) => notifyError(e),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <>
      <Card padding={0} maw={980}>
        <Group justify="space-between" p="md">
          <div>
            <Text fw={600}>API keys</Text>
            <Text size="sm" c="dimmed">For the external label printing service. Send as <Code>Authorization: Bearer &lt;key&gt;</Code>. See docs/DISPATCH_API.md.</Text>
          </div>
          <Button size="xs" leftSection={<Plus size={14} />} onClick={() => { setCreated(null); setOpen(true); }}>New key</Button>
        </Group>
        <Table className="app-table" verticalSpacing={10}>
          <Table.Thead><Table.Tr><Table.Th pl="md">Name</Table.Th><Table.Th>Key</Table.Th><Table.Th>Scopes</Table.Th><Table.Th>Last used</Table.Th><Table.Th pr="md" /></Table.Tr></Table.Thead>
          <Table.Tbody>
            {q.data!.keys.map((k) => (
              <Table.Tr key={k.id} style={{ cursor: "default", opacity: k.revokedAt ? 0.5 : 1 }}>
                <Table.Td pl="md"><Text size="sm" fw={500}>{k.name}</Text><Text size="xs" c="dimmed">created {ago(k.createdAt)}</Text></Table.Td>
                <Table.Td><Text size="sm" className="mono">{k.prefix}…</Text></Table.Td>
                <Table.Td><Group gap={4}>{k.scopes.map((s) => <Badge key={s} size="xs" variant="outline">{s}</Badge>)}</Group></Table.Td>
                <Table.Td><Text size="xs" c="dimmed">{k.lastUsedAt ? ago(k.lastUsedAt) : "never"}</Text></Table.Td>
                <Table.Td pr="md" ta="right">{k.revokedAt ? <Badge color="gray" size="sm">Revoked</Badge> : <Button size="compact-xs" color="red" variant="subtle" onClick={() => revoke.mutate(k.id)}>Revoke</Button>}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <Modal opened={open} onClose={() => setOpen(false)} title="New API key">
        {created ? (
          <Stack>
            <Alert color="yellow" variant="light">Copy this key now. It is stored only as a hash and cannot be shown again.</Alert>
            <Copyable value={created} />
            <Group justify="flex-end"><Button onClick={() => setOpen(false)}>Done</Button></Group>
          </Stack>
        ) : (
          <Stack>
            <TextInput label="Name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Stack gap={6}>
              {Object.entries(q.data!.scopes).map(([s, label]) => (
                <Checkbox key={s} label={<><Code>{s}</Code> — {label}</>} checked={scopes.includes(s)} onChange={(e) => setScopes(e.currentTarget.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />
              ))}
            </Stack>
            <Group justify="flex-end"><Button disabled={!name.trim() || !scopes.length} loading={create.isPending} onClick={() => create.mutate()}>Create key</Button></Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
