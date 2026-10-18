import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Group, Select, Stack, Text, Textarea, Tooltip, UnstyledButton } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MessageSquare, Send } from "lucide-react";
import { api, notifyError, notifySuccess, post } from "../api";
import { useCan } from "../auth";
import { dateTime } from "../format";
import { SMS_ERROR_CODES, SMS_TRIGGER_LABELS, SMS_TRIGGERS, SMS_VARIABLES, smsSegments, type SmsTrigger } from "../../shared/constants";
import type { SmsMessage } from "../types";

/** SMS composer pieces shared by the order drawer and Settings. */

const STATUS_COLOR: Record<SmsMessage["status"], string> = { sent: "teal", failed: "red", skipped: "gray", queued: "blue" };

/** Character / SMS-part counter. Bangla switches the message to Unicode (70 characters per SMS). */
export function SegmentInfo({ text }: { text: string }) {
  const s = smsSegments(text);
  return (
    <Text size="xs" c={s.segments > 2 ? "orange" : "dimmed"}>
      {s.length} characters · {s.segments} SMS{s.unicode ? " · Bangla/Unicode" : ""}
    </Text>
  );
}

/** Clickable {placeholder} chips that insert at the cursor of a textarea. */
export function VariableChips({ target, value, onChange }: { target: React.RefObject<HTMLTextAreaElement | null>; value: string; onChange: (v: string) => void }) {
  const insert = (key: string) => {
    const el = target.current;
    const token = `{${key}}`;
    const at = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? at;
    onChange(value.slice(0, at) + token + value.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    });
  };
  return (
    <Group gap={4}>
      {Object.entries(SMS_VARIABLES).map(([key, label]) => (
        <Tooltip key={key} label={label}>
          <UnstyledButton onClick={() => insert(key)} className="mono" style={{ fontSize: 11, padding: "2px 7px", borderRadius: 6, background: "var(--app-muted-bg)" }}>
            {`{${key}}`}
          </UnstyledButton>
        </Tooltip>
      ))}
    </Group>
  );
}

/** Live preview rendered by the server against a real order, so links and amounts are exact. */
export function useSmsPreview(template: string, orderId?: number) {
  const [debounced, setDebounced] = useState(template);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(template), 300);
    return () => clearTimeout(t);
  }, [template]);
  return useQuery({
    queryKey: ["sms-preview", debounced, orderId ?? null],
    queryFn: () => post<{ text: string; orderName: string | null }>("/settings/sms/preview", { template: debounced, orderId }),
    enabled: Boolean(debounced.trim()),
    staleTime: 30_000,
  });
}

export function SmsList({ messages }: { messages: SmsMessage[] }) {
  if (!messages.length) return <Text size="sm" c="dimmed">No SMS sent for this order yet.</Text>;
  return (
    <Stack gap="xs">
      {messages.map((m) => (
        <Card key={m.id} withBorder padding="sm">
          <Group justify="space-between" wrap="nowrap" mb={4}>
            <Group gap={6}>
              <Badge size="xs" color={STATUS_COLOR[m.status]}>{m.status}</Badge>
              <Text size="xs" fw={500}>{SMS_TRIGGER_LABELS[m.trigger as SmsTrigger]?.label ?? (m.trigger === "manual" ? "Manual" : m.trigger)}</Text>
              <Text size="xs" c="dimmed" className="mono">{m.phone}</Text>
            </Group>
            <Text size="xs" c="dimmed">{dateTime(m.createdAt)} · {m.sentBy}</Text>
          </Group>
          <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{m.body}</Text>
          {m.status !== "sent" && m.providerMessage && (
            <Text size="xs" c="red" mt={4}>{m.providerCode !== null ? `${m.providerCode}: ` : ""}{SMS_ERROR_CODES[m.providerCode ?? -1] ?? m.providerMessage}</Text>
          )}
        </Card>
      ))}
    </Stack>
  );
}

export function SmsTab({ orderId, phone, messages, refresh }: { orderId: number; phone: string | null; messages: SmsMessage[]; refresh: () => void }) {
  const can = useCan();
  const [template, setTemplate] = useState<SmsTrigger | null>(null);
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const preview = useSmsPreview(body, orderId);
  const send = useMutation({
    mutationFn: () => post<{ segments: number }>(`/orders/${orderId}/sms`, { body }),
    onSuccess: (r) => {
      notifySuccess(`SMS sent (${r.segments} part${r.segments > 1 ? "s" : ""})`);
      setBody("");
      setTemplate(null);
      refresh();
    },
    onError: (e) => notifyError(e),
  });
  const text = preview.data?.text ?? body;

  return (
    <Stack gap="md">
      {can("sms.send") && (
        <Card withBorder padding="md">
          <Group gap={6} mb="sm"><MessageSquare size={15} /><Text fw={600} size="sm">Send an SMS</Text><Text size="xs" c="dimmed" className="mono">{phone ?? "no valid phone"}</Text></Group>
          <Select
            size="xs"
            mb="xs"
            placeholder="Start from a template (optional)"
            clearable
            value={template}
            data={SMS_TRIGGERS.map((t) => ({ value: t, label: SMS_TRIGGER_LABELS[t].label }))}
            onChange={(v) => setTemplate(v as SmsTrigger | null)}
          />
          <TemplateLoader trigger={template} onLoad={setBody} />
          <Textarea ref={ref} autosize minRows={3} maxRows={8} placeholder="Type a message. Use {name}, {order}, {link}… to fill in this order's details." value={body} onChange={(e) => setBody(e.currentTarget.value)} />
          <Group justify="space-between" mt={6}>
            <SegmentInfo text={text} />
          </Group>
          <VariableChips target={ref} value={body} onChange={setBody} />
          {body.trim() && (
            <Alert variant="light" color="gray" mt="sm" p="xs" title={<Text size="xs" fw={600}>Customer will receive</Text>}>
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>{text}</Text>
            </Alert>
          )}
          <Group justify="flex-end" mt="sm">
            <Button size="xs" leftSection={<Send size={14} />} disabled={!body.trim() || !phone} loading={send.isPending} onClick={() => send.mutate()}>Send SMS</Button>
          </Group>
        </Card>
      )}
      <SmsList messages={messages} />
    </Stack>
  );
}

/** Copies the saved template for a moment into the composer when one is picked. */
function TemplateLoader({ trigger, onLoad }: { trigger: SmsTrigger | null; onLoad: (text: string) => void }) {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<{ settings: { smsTemplates: Record<SmsTrigger, string> } }>("/settings"), staleTime: 60_000 });
  const last = useRef<SmsTrigger | null>(null);
  useEffect(() => {
    if (trigger && trigger !== last.current && q.data) onLoad(q.data.settings.smsTemplates[trigger] ?? "");
    last.current = trigger;
  }, [trigger, q.data, onLoad]);
  return null;
}
