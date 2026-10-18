import { Badge, Button, Card, Group, RingProgress, SimpleGrid, Stack, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion, UserPlus } from "lucide-react";
import { notifyError, notifySuccess, post } from "../api";
import { ago } from "../format";
import type { FraudSummary } from "../types";

/** Steadfast fraud check, shown the same way everywhere: list badge and order card. */

const VERDICT = {
  good: { label: "Good record", color: "teal", icon: ShieldCheck },
  watch: { label: "Watch", color: "yellow", icon: ShieldAlert },
  risky: { label: "Risky — call first", color: "red", icon: ShieldAlert },
  new: { label: "New to courier", color: "gray", icon: UserPlus },
  unknown: { label: "Not available", color: "gray", icon: ShieldQuestion },
} as const;

const VOLUME: Record<string, string> = {
  none: "No parcels yet",
  low: "A few parcels",
  medium: "Some parcels",
  high: "Many parcels",
  very_high: "Very many parcels",
};

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

function details(f: FraudSummary) {
  if (f.status === "error") return `Steadfast fraud check failed: ${f.error ?? "unknown error"}`;
  const parts = [
    f.deliveryRatio === null ? "No finished parcels with Steadfast yet" : `${pct(f.deliveryRatio)} delivered · ${pct(f.cancellationRatio)} cancelled`,
    VOLUME[f.volumeBand ?? "none"] ?? f.volumeBand,
    f.totalReports ? `${f.totalReports} merchant report(s)${f.doubtfulReports ? " (doubtful)" : ""}` : "No merchant reports",
  ];
  return `${parts.join(" · ")} · checked ${ago(f.checkedAt)}`;
}

/** Compact badge for tables and the calling queue. */
export function FraudBadge({ fraud }: { fraud: FraudSummary | null }) {
  if (!fraud) return null;
  const v = VERDICT[fraud.verdict];
  const Icon = v.icon;
  const text =
    fraud.verdict === "new" ? "New" : fraud.status === "error" ? "?" : `${pct(fraud.deliveryRatio)}${fraud.totalReports ? ` · ${fraud.totalReports} report${fraud.totalReports > 1 ? "s" : ""}` : ""}`;
  return (
    <Tooltip label={details(fraud)} multiline maw={300}>
      <Badge size="sm" variant={fraud.verdict === "risky" ? "filled" : "light"} color={v.color} leftSection={<Icon size={11} />} style={{ fontVariantNumeric: "tabular-nums" }}>
        {text}
      </Badge>
    </Tooltip>
  );
}

/** Order drawer card: delivery ring, numbers, reports and a re-check button. */
export function FraudCard({ orderId, fraud, onChecked }: { orderId: number; fraud: FraudSummary | null; onChecked: () => void }) {
  const check = useMutation({
    mutationFn: () => post<{ fraud: FraudSummary | null; deferred: boolean }>(`/orders/${orderId}/fraud-check`),
    onSuccess: (r) => {
      if (r.deferred) notifySuccess("Steadfast is busy or rate-limited; the check will run automatically shortly.");
      onChecked();
    },
    onError: (e) => notifyError(e),
  });

  if (!fraud) {
    return (
      <Card withBorder padding="md">
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon variant="light" color="gray" size="lg" radius="xl"><ShieldQuestion size={18} /></ThemeIcon>
            <div>
              <Text fw={600} size="sm">Courier record</Text>
              <Text size="xs" c="dimmed">Not checked with Steadfast yet</Text>
            </div>
          </Group>
          <Button size="xs" variant="light" loading={check.isPending} onClick={() => check.mutate()}>Check now</Button>
        </Group>
      </Card>
    );
  }

  const v = VERDICT[fraud.verdict];
  const Icon = v.icon;
  const ratio = fraud.deliveryRatio;
  return (
    <Card withBorder padding="md" style={{ borderLeft: `4px solid var(--mantine-color-${v.color}-6)` }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <Group gap="md" wrap="nowrap" align="center">
          <RingProgress
            size={78}
            thickness={8}
            roundCaps
            sections={ratio === null ? [] : [{ value: ratio, color: v.color }]}
            label={<Text ta="center" fw={700} size="sm" style={{ fontVariantNumeric: "tabular-nums" }}>{ratio === null ? "—" : pct(ratio)}</Text>}
          />
          <div>
            <Text size="xs" c="dimmed" fw={500}>Courier record · all Steadfast merchants</Text>
            <Group gap={6} mt={2}>
              <Icon size={16} color={`var(--mantine-color-${v.color}-6)`} />
              <Text fw={700} c={`${v.color}.7`}>{v.label}</Text>
            </Group>
            {fraud.reasons.length > 0 && <Text size="xs" c="dimmed" mt={2}>{fraud.reasons.join(" · ")}</Text>}
          </div>
        </Group>
        <Tooltip label="Ask Steadfast again (cached results are reused for a while to respect their limits)">
          <Button size="compact-xs" variant="subtle" leftSection={<RefreshCw size={12} />} loading={check.isPending} onClick={() => check.mutate()}>
            Re-check
          </Button>
        </Tooltip>
      </Group>

      {fraud.status === "error" ? (
        <Text size="sm" c="red" mt="sm">Steadfast fraud check failed: {fraud.error}</Text>
      ) : (
        <SimpleGrid cols={{ base: 2, xs: 4 }} mt="md" spacing="xs">
          <Stat label="Delivered" value={pct(fraud.deliveryRatio)} />
          <Stat label="Cancelled" value={pct(fraud.cancellationRatio)} />
          <Stat label="Volume" value={VOLUME[fraud.volumeBand ?? "none"] ?? "—"} small />
          <Stat label="Merchant reports" value={String(fraud.totalReports)} tone={fraud.totalReports && !fraud.doubtfulReports ? "red" : undefined} />
        </SimpleGrid>
      )}
      {fraud.categories.length > 0 && (
        <Group gap={4} mt="xs">
          {fraud.categories.map((c) => <Badge key={c} size="xs" variant="outline" color="red">{c}</Badge>)}
        </Group>
      )}
      <Text size="xs" c="dimmed" mt="xs">Checked {ago(fraud.checkedAt)}{fraud.doubtfulReports ? " · Steadfast marks the reports as doubtful" : ""}</Text>
    </Card>
  );
}

function Stat({ label, value, small, tone }: { label: string; value: string; small?: boolean; tone?: string }) {
  return (
    <Stack gap={0} p={8} style={{ borderRadius: 8, background: "var(--app-muted-bg)" }}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text fw={700} size={small ? "xs" : "md"} c={tone} style={{ fontVariantNumeric: "tabular-nums" }}>{value}</Text>
    </Stack>
  );
}
