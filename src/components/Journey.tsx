import { useState } from "react";
import { Badge, Card, Chip, Group, SimpleGrid, Stack, Switch, Text, Timeline } from "@mantine/core";
import { Bot, Box, MessageSquare, Phone, ShoppingBag, Truck, User, Warehouse, type LucideIcon } from "lucide-react";
import { dateTime, titleCase } from "../format";
import type { Activity, Journey, JourneySource } from "../types";

/** Everything that happened to an order, merged from every source, plus how long each step took. */

const SOURCES: Record<JourneySource, { label: string; color: string; icon: LucideIcon }> = {
  shopify: { label: "Shopify", color: "green", icon: ShoppingBag },
  call: { label: "Calls", color: "grape", icon: Phone },
  booking: { label: "Booking", color: "blue", icon: Box },
  warehouse: { label: "Warehouse", color: "indigo", icon: Warehouse },
  courier: { label: "Courier", color: "cyan", icon: Truck },
  sms: { label: "SMS", color: "orange", icon: MessageSquare },
  staff: { label: "Staff", color: "gray", icon: User },
  system: { label: "System", color: "gray", icon: Bot },
};

const STEPS: { key: keyof Journey["milestones"]; label: string }[] = [
  { key: "placed", label: "Placed" },
  { key: "confirmed", label: "Confirmed" },
  { key: "booked", label: "Booked" },
  { key: "printed", label: "Label printed" },
  { key: "packed", label: "Packed (scanned)" },
  { key: "handedOver", label: "Handed to rider" },
  { key: "pickedUp", label: "Picked up by courier" },
  { key: "outcome", label: "Delivered / returned" },
  { key: "paid", label: "COD paid out" },
];

/** "2h 15m", "3d 4h" — the gap between two milestones. */
export function duration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const mins = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ${mins % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function JourneyTab({ journey, activity }: { journey: Journey; activity: Activity[] }) {
  const [hidden, setHidden] = useState<JourneySource[]>([]);
  const [raw, setRaw] = useState(false);
  const m = journey.milestones;
  const reached = STEPS.filter((s) => m[s.key]);
  const present = [...new Set(journey.entries.map((e) => e.source))];
  const entries = journey.entries.filter((e) => !hidden.includes(e.source));

  return (
    <Stack gap="md">
      <Card withBorder padding="md">
        <Group justify="space-between" mb="xs">
          <Text fw={600} size="sm">Milestones</Text>
          {m.placed && reached.length > 1 && (
            <Text size="xs" c="dimmed">Total {duration(m.placed, m[reached[reached.length - 1].key] as string)}</Text>
          )}
        </Group>
        <SimpleGrid cols={{ base: 1, xs: 3 }} spacing={6} verticalSpacing={6}>
          {STEPS.map((s, i) => {
            const at = m[s.key] as string | null;
            const prev = [...STEPS.slice(0, i)].reverse().find((p) => m[p.key]);
            const gap = prev ? duration(m[prev.key] as string, at) : null;
            const label = s.key === "outcome" && m.outcomeKind ? titleCase(m.outcomeKind) : s.label;
            return (
              <div key={s.key} style={{ padding: "6px 8px", borderRadius: 8, background: at ? "var(--app-muted-bg)" : undefined, opacity: at ? 1 : 0.45 }}>
                <Text size="xs" fw={600}>{label}</Text>
                <Text size="xs" c="dimmed">{at ? dateTime(at) : "—"}</Text>
                {gap && <Text size="xs" c="blue">+{gap}</Text>}
              </div>
            );
          })}
        </SimpleGrid>
      </Card>

      <Group justify="space-between" align="center">
        <Chip.Group multiple value={present.filter((p) => !hidden.includes(p))} onChange={(v) => setHidden(present.filter((p) => !v.includes(p)) as JourneySource[])}>
          <Group gap={4}>
            {present.map((p) => (
              <Chip key={p} value={p} size="xs" color={SOURCES[p].color}>{SOURCES[p].label}</Chip>
            ))}
          </Group>
        </Chip.Group>
        <Switch size="xs" label="Raw activity log" checked={raw} onChange={(e) => setRaw(e.currentTarget.checked)} />
      </Group>

      {raw ? (
        <RawActivity activity={activity} />
      ) : entries.length === 0 ? (
        <Text size="sm" c="dimmed">Nothing recorded yet.</Text>
      ) : (
        <Timeline bulletSize={24} lineWidth={2}>
          {entries.map((e, i) => {
            const src = SOURCES[e.source];
            const Icon = src.icon;
            return (
              <Timeline.Item
                key={`${e.at}-${i}`}
                bullet={<Icon size={12} />}
                color={e.tone === "bad" ? "red" : e.tone === "warn" ? "orange" : e.tone === "good" ? "teal" : src.color}
                title={
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={500}>{e.title}</Text>
                    <Badge size="xs" variant="light" color={src.color}>{src.label}</Badge>
                  </Group>
                }
              >
                {e.detail && <Text size="xs" c="dimmed" lineClamp={3} style={{ wordBreak: "break-word" }}>{e.detail}</Text>}
                <Text size="xs" c="dimmed">{dateTime(e.at)}{e.actor ? ` · ${e.actor}` : ""}</Text>
              </Timeline.Item>
            );
          })}
        </Timeline>
      )}
    </Stack>
  );
}

function RawActivity({ activity }: { activity: Activity[] }) {
  if (!activity.length) return <Text size="sm" c="dimmed">No activity recorded.</Text>;
  return (
    <Timeline bulletSize={14} lineWidth={2}>
      {activity.map((a) => (
        <Timeline.Item key={a.id} title={<Text size="sm"><b>{a.actor}</b> <Text span c="dimmed">{titleCase(a.action.replace(".", " · "))}</Text></Text>}>
          {a.details && typeof a.details === "object" && Object.keys(a.details as object).length > 0 ? (
            <Text size="xs" c="dimmed" className="mono" lineClamp={3}>{JSON.stringify(a.details)}</Text>
          ) : null}
          <Text size="xs" c="dimmed">{dateTime(a.createdAt)}</Text>
        </Timeline.Item>
      ))}
    </Timeline>
  );
}
