import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, SimpleGrid, Stack, Switch, Text, Textarea, TextInput } from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, MessageSquare, Send, Wallet, XCircle } from "lucide-react";
import { api, notifyError, notifySuccess, post, put } from "../../api";
import { useCan } from "../../auth";
import { SegmentInfo, SmsList, useSmsPreview, VariableChips } from "../../components/Sms";
import { ago } from "../../format";
import { DEFAULT_SMS_TEMPLATES, SMS_TRIGGER_LABELS, SMS_TRIGGERS, type SmsTrigger } from "../../../shared/constants";
import type { SmsMessage } from "../../types";

export type SmsSettingsData = {
  smsEnabled: boolean;
  smsTriggers: Record<SmsTrigger, boolean>;
  smsTemplates: Record<SmsTrigger, string>;
};
export type SmsStatus = {
  configured: boolean;
  senderId: string | null;
  lastError: { code: number; message: string; at: string } | null;
  last24h: { sent: number; failed: number; segments: number };
};

/** Settings → SMS: on/off, which moments send, the templates, a test message and the send log. */
export function SmsSettings({ settings, status }: { settings: SmsSettingsData; status: SmsStatus }) {
  const can = useCan();
  const qc = useQueryClient();
  const disabled = !can("settings.manage");
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const save = useMutation({
    mutationFn: () => put("/settings", s),
    onSuccess: () => {
      notifySuccess("SMS settings saved");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => notifyError(e),
  });
  const balance = useMutation({ mutationFn: () => api<{ ok: boolean; balance?: number | null; error?: string }>("/settings/sms/balance"), onError: (e) => notifyError(e) });
  const log = useQuery({ queryKey: ["sms-log"], queryFn: () => api<{ messages: SmsMessage[] }>("/settings/sms/log?limit=50"), refetchInterval: 60_000 });

  return (
    <Stack maw={860}>
      <Card>
        <Group justify="space-between" align="flex-start">
          <div>
            <Group gap={8}>
              <MessageSquare size={18} />
              <Text fw={600}>Customer SMS</Text>
              {status.configured ? <Badge color="teal" leftSection={<CheckCircle2 size={11} />}>API key set on server</Badge> : <Badge color="gray" leftSection={<XCircle size={11} />}>No API key</Badge>}
            </Group>
            <Text size="sm" c="dimmed" mt={4} maw={560}>
              The SMS API key is a server secret (<code>SMS_API_KEY</code>), never stored in the database or shown in the browser.
              {status.senderId ? ` Sender ID: ${status.senderId}.` : ""} Each order gets each automatic message at most once.
            </Text>
          </div>
          {status.configured && !disabled && (
            <Button size="xs" variant="default" leftSection={<Wallet size={14} />} loading={balance.isPending} onClick={() => balance.mutate()}>
              {balance.data?.ok ? `Balance ৳${balance.data.balance ?? "?"}` : "Check balance"}
            </Button>
          )}
        </Group>
        {balance.data && !balance.data.ok && <Alert mt="sm" color="red" variant="light">{balance.data.error}</Alert>}
        {status.lastError && (
          <Alert mt="sm" color="red" variant="light" title={`SMS provider error ${status.lastError.code} · ${ago(status.lastError.at)}`}>
            {status.lastError.message}. Automatic messages fail until this is fixed; they are not retried.
          </Alert>
        )}
        {!status.configured && (
          <Alert mt="sm" color="blue" variant="light" title="Add the API key on the server">
            Cloudflare dashboard → Workers → this Worker → Settings → Variables and Secrets → add secret <code>SMS_API_KEY</code>
            (or run <code>npx wrangler secret put SMS_API_KEY</code>). Optional: <code>SMS_SENDER_ID</code>.
          </Alert>
        )}
        <Switch
          mt="md"
          size="md"
          label={s.smsEnabled ? "Automatic SMS is ON" : "Automatic SMS is OFF"}
          description="Manual messages from an order work either way (when the key is set)."
          checked={s.smsEnabled}
          onChange={(e) => setS({ ...s, smsEnabled: e.currentTarget.checked })}
          disabled={disabled}
        />
        <Text size="xs" c="dimmed" mt="sm">
          Last 24 hours: {status.last24h.sent} sent ({status.last24h.segments} SMS parts) · {status.last24h.failed} failed
        </Text>
      </Card>

      <Text fw={600}>Messages</Text>
      <Text size="sm" c="dimmed" mt={-10}>Click a <code>{"{placeholder}"}</code> to insert it. The preview uses your newest order.</Text>
      {SMS_TRIGGERS.map((t) => (
        <TemplateCard
          key={t}
          trigger={t}
          enabled={s.smsTriggers[t]}
          template={s.smsTemplates[t]}
          disabled={disabled}
          onToggle={(v) => setS({ ...s, smsTriggers: { ...s.smsTriggers, [t]: v } })}
          onChange={(v) => setS({ ...s, smsTemplates: { ...s.smsTemplates, [t]: v } })}
        />
      ))}
      {!disabled && (
        <Group justify="flex-end">
          <Button loading={save.isPending} onClick={() => save.mutate()}>Save SMS settings</Button>
        </Group>
      )}

      {!disabled && status.configured && <TestSms />}

      <Card>
        <Text fw={600} mb="sm">Recent messages</Text>
        <SmsList messages={log.data?.messages ?? []} />
      </Card>
    </Stack>
  );
}

function TemplateCard({ trigger, enabled, template, disabled, onToggle, onChange }: {
  trigger: SmsTrigger; enabled: boolean; template: string; disabled: boolean; onToggle: (v: boolean) => void; onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const preview = useSmsPreview(template);
  const meta = SMS_TRIGGER_LABELS[trigger];
  return (
    <Card padding="md" style={{ opacity: enabled ? 1 : 0.75 }}>
      <Group justify="space-between" mb="xs">
        <div>
          <Text fw={600} size="sm">{meta.label}</Text>
          <Text size="xs" c="dimmed">{meta.hint}</Text>
        </div>
        <Switch checked={enabled} onChange={(e) => onToggle(e.currentTarget.checked)} disabled={disabled} label={enabled ? "Sends" : "Off"} />
      </Group>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        <div>
          <Textarea ref={ref} autosize minRows={3} value={template} onChange={(e) => onChange(e.currentTarget.value)} disabled={disabled} />
          <Group justify="space-between" mt={4}>
            <SegmentInfo text={preview.data?.text ?? template} />
            {!disabled && template !== DEFAULT_SMS_TEMPLATES[trigger] && (
              <Button size="compact-xs" variant="subtle" onClick={() => onChange(DEFAULT_SMS_TEMPLATES[trigger])}>Reset</Button>
            )}
          </Group>
          {!disabled && <VariableChips target={ref} value={template} onChange={onChange} />}
        </div>
        <div style={{ padding: 10, borderRadius: 12, background: "var(--app-muted-bg)" }}>
          <Text size="xs" c="dimmed" mb={4}>Preview{preview.data?.orderName ? ` · ${preview.data.orderName}` : ""}</Text>
          <Text size="sm" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{preview.data?.text ?? template}</Text>
        </div>
      </SimpleGrid>
    </Card>
  );
}

function TestSms() {
  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () => post<{ segments: number }>("/settings/sms/test", { phone, body }),
    onSuccess: () => notifySuccess("Test SMS sent"),
    onError: (e) => notifyError(e),
  });
  return (
    <Card>
      <Text fw={600} mb={4}>Send a test SMS</Text>
      <Text size="xs" c="dimmed" mb="sm">Until the first recharge, the provider only delivers to the number the account was registered with (error 421).</Text>
      <Group align="flex-end">
        <TextInput label="Phone" placeholder="01XXXXXXXXX" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} w={180} />
        <TextInput label="Message (optional)" placeholder="Test message" value={body} onChange={(e) => setBody(e.currentTarget.value)} style={{ flex: 1 }} />
        <Button leftSection={<Send size={14} />} loading={send.isPending} disabled={!phone} onClick={() => send.mutate()}>Send test</Button>
      </Group>
    </Card>
  );
}
