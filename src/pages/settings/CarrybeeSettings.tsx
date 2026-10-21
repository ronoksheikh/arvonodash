import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Group, NumberInput, PasswordInput, SegmentedControl, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { modals } from "@mantine/modals";
import { CheckCircle2, Plug, Truck } from "lucide-react";
import { notifyError, notifySuccess, post, put } from "../../api";
import { Copyable } from "../../components/ui";
import { ago } from "../../format";
import { COURIERS, type CourierId } from "../../../shared/couriers";

type CredInfo = { set: boolean; source: "worker_secret" | "dashboard" | null; hint: string | null };
type Store = { id: string; name: string; address: string; is_active?: boolean; is_approved?: boolean; is_default_pickup_store?: boolean };

export type CourierSettings = {
  courier: CourierId;
  carrybeeEnvironment: "sandbox" | "production";
  carrybeeStoreId: string;
  carrybeeDefaultWeightGrams: number;
  carrybeeExpress: boolean;
};

/** Which courier new bookings go to. Parcels already booked keep updating through their own courier. */
export function CourierSwitch({ settings, ready, disabled }: { settings: CourierSettings; ready: Record<CourierId, boolean>; disabled: boolean }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (courier: CourierId) => put("/settings", { courier }),
    onSuccess: (_r, courier) => {
      notifySuccess(`New bookings now go to ${COURIERS[courier].fullName}`);
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => notifyError(e),
  });
  const pick = (courier: CourierId) =>
    modals.openConfirmModal({
      title: `Book new parcels with ${COURIERS[courier].fullName}?`,
      children: (
        <Text size="sm">
          From now on, every booking (manual, bulk and auto-booking) goes to {COURIERS[courier].fullName}. Parcels already booked stay with their courier and keep
          updating until they're finished.
        </Text>
      ),
      labels: { confirm: "Switch", cancel: "Cancel" },
      onConfirm: () => save.mutate(courier),
    });
  return (
    <Card style={{ gridColumn: "1 / -1" }}>
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap={8}><Truck size={18} /><Text fw={600}>Courier for new bookings</Text></Group>
          <Text size="sm" c="dimmed" mt={4} maw={620}>Switch any time. Only new bookings change; every parcel keeps the courier it was booked with until it's delivered or returned.</Text>
        </div>
        <SegmentedControl
          value={settings.courier}
          disabled={disabled || save.isPending}
          onChange={(v) => v !== settings.courier && pick(v as CourierId)}
          data={(Object.keys(COURIERS) as CourierId[]).map((id) => ({ value: id, label: `${COURIERS[id].label}${ready[id] ? "" : " (not connected)"}`, disabled: !ready[id] && id !== settings.courier }))}
        />
      </Group>
    </Card>
  );
}

export function CarrybeeCard({ settings, creds, configured, webhookUrl, webhookSecret, lastWebhook, setupUntil, disabled }: {
  settings: CourierSettings;
  creds: Record<string, CredInfo> | null;
  configured: boolean;
  webhookUrl: string;
  webhookSecret: string | null;
  lastWebhook: { ok: boolean; at: string; reason: "mismatch" | "missing" | null; receivedHint: string | null; setupCheck?: boolean } | null;
  setupUntil: string | null;
  disabled: boolean;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({});
  const [s, setS] = useState(settings);
  const [stores, setStores] = useState<Store[] | null>(null);
  useEffect(() => setS(settings), [settings]);
  const refresh = () => qc.invalidateQueries({ queryKey: ["settings"] });

  const saveCreds = useMutation({
    mutationFn: (body: Record<string, string | null>) => put("/settings/connections", body),
    onSuccess: () => { setForm({}); notifySuccess("Carrybee credentials saved"); refresh(); },
    onError: (e) => notifyError(e, "Could not save"),
  });
  const saveSettings = useMutation({
    mutationFn: () => put("/settings", { carrybeeEnvironment: s.carrybeeEnvironment, carrybeeStoreId: s.carrybeeStoreId, carrybeeDefaultWeightGrams: s.carrybeeDefaultWeightGrams, carrybeeExpress: s.carrybeeExpress }),
    onSuccess: () => { notifySuccess("Carrybee settings saved"); refresh(); },
    onError: (e) => notifyError(e),
  });
  const test = useMutation({
    mutationFn: () => post<{ ok: boolean; error?: string; stores?: Store[] }>("/settings/test/carrybee"),
    onSuccess: (r) => { if (r.ok) setStores(r.stores ?? []); },
  });
  const regenerate = useMutation({
    mutationFn: () => post("/settings/connections/regenerate-carrybee-secret"),
    onSuccess: () => { notifySuccess("New secret generated — update it on Carrybee's Webhook Integration page"); refresh(); },
    onError: (e) => notifyError(e),
  });

  const openWindow = useMutation({
    mutationFn: () => post<{ until: string }>("/settings/carrybee/webhook-setup"),
    onSuccess: () => { notifySuccess("Setup window open for 10 minutes — press Add Webhook at Carrybee now"); refresh(); },
    onError: (e) => notifyError(e),
  });
  const windowOpen = Boolean(setupUntil && setupUntil > new Date().toISOString());

  const keys = ["CARRYBEE_CLIENT_ID", "CARRYBEE_CLIENT_SECRET", "CARRYBEE_CLIENT_CONTEXT"];
  const dirty = keys.some((k) => form[k]?.trim());
  const field = (key: string, label: string, secret: boolean, description?: string) => {
    const info = creds?.[key];
    const fromSecret = info?.source === "worker_secret";
    const Input = secret ? PasswordInput : TextInput;
    return (
      <Input
        label={label}
        description={fromSecret ? "Set as a Cloudflare Worker secret (overrides this field)" : description}
        placeholder={info?.set ? `${info.hint ?? "Saved"} — leave empty to keep` : undefined}
        value={form[key] ?? ""}
        onChange={(e) => setForm({ ...form, [key]: e.currentTarget.value })}
        disabled={disabled || fromSecret}
        autoComplete="off"
        rightSection={info?.set && !secret ? <CheckCircle2 size={15} color="var(--mantine-color-teal-6)" /> : undefined}
      />
    );
  };
  const settingsDirty = JSON.stringify(s) !== JSON.stringify(settings);
  const active = settings.courier === "carrybee";

  return (
    <Card>
      <Group justify="space-between" mb="md">
        <Text fw={600}>Carrybee</Text>
        <Group gap={6}>
          <Badge color={active ? "teal" : "gray"} variant={active ? "filled" : "light"}>{active ? "Booking new parcels" : "Off"}</Badge>
          <Badge color={configured ? "teal" : "red"}>{configured ? "Configured" : "Not configured"}</Badge>
        </Group>
      </Group>
      <Stack gap="sm">
        <div>
          <Text size="sm" fw={500} mb={4}>Environment</Text>
          <SegmentedControl
            size="xs"
            value={s.carrybeeEnvironment}
            onChange={(v) => setS({ ...s, carrybeeEnvironment: v as "sandbox" | "production" })}
            data={[{ value: "sandbox", label: "Sandbox (testing)" }, { value: "production", label: "Production (live)" }]}
            disabled={disabled}
          />
          <Text size="xs" c="dimmed" mt={4}>Credentials belong to one environment; use the matching Client-ID / Secret / Context.</Text>
        </div>
        {field("CARRYBEE_CLIENT_ID", "Client-ID", false, "Carrybee → API Credentials")}
        {field("CARRYBEE_CLIENT_SECRET", "Client-Secret", true)}
        {field("CARRYBEE_CLIENT_CONTEXT", "Client-Context", true)}
        {!disabled && (
          <Group gap="xs">
            <Button size="xs" disabled={!dirty} loading={saveCreds.isPending} onClick={() => saveCreds.mutate(Object.fromEntries(keys.filter((k) => form[k]?.trim()).map((k) => [k, form[k].trim()])))}>Save credentials</Button>
            <Button variant="default" size="xs" leftSection={<Plug size={14} />} disabled={!configured || settingsDirty} loading={test.isPending} onClick={() => test.mutate()}>
              Test & load stores
            </Button>
          </Group>
        )}
        {settingsDirty && configured && <Text size="xs" c="dimmed">Save the environment first, then test.</Text>}
        {test.data && (test.data.ok ? <Alert color="teal" variant="light">Connected. {test.data.stores?.length ?? 0} pickup store(s) found.</Alert> : <Alert color="red" variant="light">{test.data.error}</Alert>)}

        <Text fw={500} size="sm" mt="sm">Parcel defaults</Text>
        {stores ? (
          <Select
            label="Pickup store"
            description="Where Carrybee collects your parcels"
            value={s.carrybeeStoreId || null}
            onChange={(v) => setS({ ...s, carrybeeStoreId: v ?? "" })}
            data={stores.map((st) => ({ value: st.id, label: `${st.name}${st.is_default_pickup_store ? " (default)" : ""}${st.is_approved === false ? " — not approved yet" : ""}` }))}
            disabled={disabled}
          />
        ) : (
          <TextInput label="Pickup store ID" description={'Press "Test & load stores" to choose from your Carrybee stores'} value={s.carrybeeStoreId} onChange={(e) => setS({ ...s, carrybeeStoreId: e.currentTarget.value.trim() })} disabled={disabled} />
        )}
        <Group grow>
          <NumberInput label="Parcel weight (grams)" description="Sent with every parcel (1–25,000)" min={1} max={25000} value={s.carrybeeDefaultWeightGrams} onChange={(v) => setS({ ...s, carrybeeDefaultWeightGrams: Number(v) || 500 })} disabled={disabled} />
          <Switch mt={24} label="Express delivery" checked={s.carrybeeExpress} onChange={(e) => setS({ ...s, carrybeeExpress: e.currentTarget.checked })} disabled={disabled} />
        </Group>
        {!disabled && <Group><Button size="xs" disabled={!settingsDirty} loading={saveSettings.isPending} onClick={() => saveSettings.mutate()}>Save Carrybee settings</Button></Group>}

        <Text fw={500} size="sm" mt="sm">Webhook (Carrybee → Webhook Integration)</Text>
        <Text size="xs" c="dimmed">1. Paste this URL at Carrybee</Text>
        <Copyable value={webhookUrl} />
        <Text size="xs" c="dimmed" mt={4}>2. Copy the integration secret Carrybee shows there and save it here. Both sides must hold exactly the same value.</Text>
        {!disabled && creds?.CARRYBEE_WEBHOOK_SECRET?.source !== "worker_secret" && (
          <Group gap="xs" align="flex-end">
            <TextInput size="xs" style={{ flex: 1 }} label="Carrybee's integration secret" placeholder="e.g. 40489fe0-9386-4fc9-8e92-…" value={form.CARRYBEE_WEBHOOK_SECRET ?? ""} onChange={(e) => setForm({ ...form, CARRYBEE_WEBHOOK_SECRET: e.currentTarget.value })} autoComplete="off" />
            <Button size="xs" disabled={(form.CARRYBEE_WEBHOOK_SECRET?.trim().length ?? 0) < 16} loading={saveCreds.isPending} onClick={() => saveCreds.mutate({ CARRYBEE_WEBHOOK_SECRET: form.CARRYBEE_WEBHOOK_SECRET.trim() })}>Save secret</Button>
          </Group>
        )}
        <Text size="xs" c="dimmed">3. Carrybee's "Add Webhook" check doesn't send the secret, so open the setup window here first, then press Add Webhook at Carrybee within 10 minutes.</Text>
        {!disabled && (
          <Group gap="xs">
            <Button size="xs" variant="light" loading={openWindow.isPending} disabled={!webhookSecret} onClick={() => openWindow.mutate()}>
              Open 10-minute setup window
            </Button>
            {windowOpen && <Text size="xs" c="teal">Open until {new Date(setupUntil!).toLocaleTimeString()} — press Add Webhook at Carrybee now.</Text>}
          </Group>
        )}
        <Text size="xs" c="dimmed">Real parcel updates always need the secret header; only the one setup check is answered without it.</Text>
        <Text size="xs" c="dimmed" mt={4}>Secret saved here now</Text>
        {webhookSecret ? <Copyable value={webhookSecret} /> : <Text size="sm" c="dimmed">Hidden</Text>}
        {lastWebhook && (
          lastWebhook.ok ? (
            <Alert color="teal" variant="light" p="xs">{lastWebhook.setupCheck ? "Carrybee's setup check passed" : "Last Carrybee webhook accepted"} {ago(lastWebhook.at)}.</Alert>
          ) : (
            <Alert color="red" variant="light" p="xs" title={`Last Carrybee webhook rejected ${ago(lastWebhook.at)}`}>
              {lastWebhook.reason === "missing"
                ? lastWebhook.setupCheck
                  ? "Carrybee's setup check arrived without the secret header. Open the setup window above, then press Add Webhook at Carrybee again."
                  : "A parcel update arrived without the X-CB-Webhook-Integration-Header secret, so it was refused. Statuses still update by polling every few minutes."
                : `The secret it carried (ending ${lastWebhook.receivedHint}) doesn't match the one saved here. Paste Carrybee's secret above and save, then try again at Carrybee.`}
            </Alert>
          )
        )}
        {!disabled && creds?.CARRYBEE_WEBHOOK_SECRET?.source !== "worker_secret" && (
          <Button size="compact-xs" variant="subtle" color="red" w="fit-content" loading={regenerate.isPending} onClick={() => modals.openConfirmModal({
            title: "Generate a new random secret?",
            children: <Text size="sm">Only if Carrybee lets you type your own secret: paste the new one there too. Until both match, Carrybee webhooks are rejected (statuses keep updating by polling).</Text>,
            labels: { confirm: "Generate", cancel: "Cancel" },
            confirmProps: { color: "red" },
            onConfirm: () => regenerate.mutate(),
          })}>Generate a random secret instead</Button>
        )}
        <Text size="xs" c="dimmed">Carrybee sends every parcel update here (picked up, in transit, delivered, returned, paid…). Statuses are also checked every few minutes in case a webhook is missed.</Text>
      </Stack>
    </Card>
  );
}
