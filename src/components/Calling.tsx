import { useState } from "react";
import { Badge, Button, Card, Group, Menu, Modal, Stack, Text, Textarea, Timeline, UnstyledButton, SimpleGrid } from "@mantine/core";
import { DateTimePicker } from "@mantine/dates";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, PhoneCall, PhoneMissed, PhoneOff, RotateCcw } from "lucide-react";
import { notifyError, notifySuccess, post } from "../api";
import { useCan } from "../auth";
import { CallingBadge } from "./ui";
import { ago, dateTime } from "../format";
import { CALLING_STATUSES } from "../../shared/constants";
import type { CallLog } from "../types";

const ICONS: Record<string, typeof PhoneCall> = { confirmed: CheckCircle2, no_answer: PhoneMissed, call_again: RotateCcw, rejected: PhoneOff, not_called: PhoneCall };

function useSetCalling(orderId: number, onDone: () => void) {
  return useMutation({
    mutationFn: (body: { status: string; note?: string; callbackAt?: string | null }) => post<{ processingStatus: string }>(`/orders/${orderId}/calling`, body),
    onSuccess: (_r, v) => {
      notifySuccess(v.status === "confirmed" ? "Confirmed — marked In progress in Shopify" : `Marked ${CALLING_STATUSES[v.status as keyof typeof CALLING_STATUSES].label}`);
      onDone();
    },
    onError: (e) => notifyError(e, "Could not update calling status"),
  });
}

/** Call outcome dialog: note + optional callback time. */
export function CallModal({ orderId, status, opened, onClose, onDone }: { orderId: number; status: string | null; opened: boolean; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState("");
  const [callbackAt, setCallbackAt] = useState<string | null>(null);
  const m = useSetCalling(orderId, () => {
    setNote("");
    setCallbackAt(null);
    onClose();
    onDone();
  });
  const label = status ? CALLING_STATUSES[status as keyof typeof CALLING_STATUSES]?.label : "";
  return (
    <Modal opened={opened} onClose={onClose} title={`Mark as ${label}`} size="sm">
      <Stack>
        <Textarea label="Call note" placeholder={status === "rejected" ? "Why did the customer reject?" : "What happened on the call?"} autosize minRows={2} value={note} onChange={(e) => setNote(e.currentTarget.value)} data-autofocus />
        {(status === "call_again" || status === "no_answer") && (
          <DateTimePicker label="Call back at" clearable value={callbackAt} onChange={(v) => setCallbackAt(v ? new Date(v).toISOString() : null)} minDate={new Date()} />
        )}
        <Group justify="flex-end">
          <Button color={status === "rejected" ? "red" : undefined} loading={m.isPending} onClick={() => m.mutate({ status: status!, note: note || undefined, callbackAt })}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** Clickable calling badge for tables: confirm in one click, other outcomes ask for a note. */
export function CallingMenu({ orderId, status, locked, onDone }: { orderId: number; status: string; locked?: boolean; onDone: () => void }) {
  const can = useCan();
  const [pending, setPending] = useState<string | null>(null);
  const quick = useSetCalling(orderId, onDone);
  if (locked || !can("orders.call")) return <CallingBadge status={status} />;
  return (
    <>
      <Menu position="bottom-start" withinPortal>
        <Menu.Target>
          <UnstyledButton onClick={(e) => e.stopPropagation()} aria-label="Change calling status">
            <Group gap={2} wrap="nowrap">
              <CallingBadge status={status} />
              <ChevronDown size={12} color="var(--mantine-color-dimmed)" />
            </Group>
          </UnstyledButton>
        </Menu.Target>
        <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
          <Menu.Label>Call outcome</Menu.Label>
          {Object.entries(CALLING_STATUSES)
            .filter(([k]) => k !== "not_called" && k !== status)
            .map(([k, s]) => {
              const Icon = ICONS[k];
              return (
                <Menu.Item key={k} leftSection={<Icon size={14} color={`var(--mantine-color-${s.color}-6)`} />} onClick={() => (k === "confirmed" ? quick.mutate({ status: k }) : setPending(k))}>
                  {s.label}
                </Menu.Item>
              );
            })}
        </Menu.Dropdown>
      </Menu>
      <div onClick={(e) => e.stopPropagation()}>
        <CallModal orderId={orderId} status={pending} opened={pending !== null} onClose={() => setPending(null)} onDone={onDone} />
      </div>
    </>
  );
}

/** Calling section in the order drawer: outcome buttons + full call history. */
export function CallingPanel({
  orderId,
  status,
  attempts,
  callbackAt,
  locked,
  calls,
  onDone,
}: {
  orderId: number;
  status: string;
  attempts: number;
  callbackAt: string | null;
  locked: boolean;
  calls: CallLog[];
  onDone: () => void;
}) {
  const can = useCan();
  const [pending, setPending] = useState<string | null>(null);
  const quick = useSetCalling(orderId, onDone);
  return (
    <Card padding="md">
      <Group justify="space-between" mb="sm">
        <Group gap={8}>
          <PhoneCall size={15} />
          <Text fw={600} size="sm">Customer verification</Text>
          <CallingBadge status={status} />
        </Group>
        <Text size="xs" c="dimmed">
          {attempts} call{attempts === 1 ? "" : "s"}
          {callbackAt ? ` · call back ${dateTime(callbackAt)}` : ""}
        </Text>
      </Group>
      {can("orders.call") && !locked && (
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
          <Button size="xs" color="teal" leftSection={<CheckCircle2 size={14} />} disabled={status === "confirmed"} loading={quick.isPending} onClick={() => quick.mutate({ status: "confirmed" })}>
            Confirmed
          </Button>
          <Button size="xs" variant="light" color="yellow" leftSection={<PhoneMissed size={14} />} onClick={() => setPending("no_answer")}>No answer</Button>
          <Button size="xs" variant="light" color="orange" leftSection={<RotateCcw size={14} />} onClick={() => setPending("call_again")}>Call again</Button>
          <Button size="xs" variant="light" color="red" leftSection={<PhoneOff size={14} />} onClick={() => setPending("rejected")}>Rejected</Button>
        </SimpleGrid>
      )}
      {locked && <Text size="xs" c="dimmed">Booked with the courier — confirmation is locked.</Text>}
      {calls.length > 0 && (
        <Timeline bulletSize={14} lineWidth={2} mt="md">
          {calls.map((c) => (
            <Timeline.Item key={c.id} title={<Group gap={6}><CallingBadge status={c.outcome} size="xs" /><Text size="xs" c="dimmed">{c.userName ?? "—"} · {ago(c.createdAt)}</Text></Group>}>
              {c.note && <Text size="sm" mt={2}>{c.note}</Text>}
              {c.callbackAt && <Badge size="xs" variant="outline" mt={4}>Call back {dateTime(c.callbackAt)}</Badge>}
            </Timeline.Item>
          ))}
        </Timeline>
      )}
      <CallModal orderId={orderId} status={pending} opened={pending !== null} onClose={() => setPending(null)} onDone={onDone} />
    </Card>
  );
}
