import { useEffect, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Center, Group, Loader, Pagination, Paper, Stack, Text, ThemeIcon, Title, Tooltip, CopyButton, ActionIcon } from "@mantine/core";
import { AlertTriangle, Check, Copy, Inbox, ShieldAlert, Timer } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { CALLING_STATUSES, COURIER_STAGES, DISPATCH_STATUSES, FULFILLMENT_STATES, LABEL_STATUSES, RISK_FLAGS, SHOPIFY_SYNC_STATUSES, STEADFAST_STATUSES, RETURN_STATUSES } from "../../shared/constants";
import type { CustomStatus } from "../types";
import { titleCase } from "../format";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-end" mb="lg" gap="sm" wrap="wrap">
      <div>
        <Title order={2} fz={24} fw={600} lh={1.2}>
          {title}
        </Title>
        {description && (
          <Text c="dimmed" size="sm" mt={4}>
            {description}
          </Text>
        )}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

export function StageBadge({ stage, size = "sm" }: { stage: string; size?: "xs" | "sm" | "md" }) {
  const s = COURIER_STAGES[stage as keyof typeof COURIER_STAGES] ?? { label: titleCase(stage), color: "gray" };
  return (
    <Badge color={s.color} size={size} variant="dot">
      {s.label}
    </Badge>
  );
}

export function SteadfastStatusBadge({ status }: { status: string }) {
  const label = STEADFAST_STATUSES[status] ?? titleCase(status);
  const color = status.startsWith("delivered") ? "teal" : status.startsWith("partial") ? "lime" : status.startsWith("cancelled") ? "red" : status === "hold" ? "yellow" : status === "pending" ? "indigo" : status.startsWith("unknown") || status === "unconfirmed" ? "orange" : "blue";
  return (
    <Badge color={color} size="sm">
      {label}
    </Badge>
  );
}

export function FulfillmentBadge({ state, error }: { state: string; error?: string | null }) {
  const s = FULFILLMENT_STATES[state as keyof typeof FULFILLMENT_STATES] ?? { label: titleCase(state), color: "gray" };
  const badge = (
    <Badge color={s.color} size="sm" variant={state === "fulfilled" ? "light" : "outline"}>
      {s.label}
    </Badge>
  );
  return error ? <Tooltip label={error} multiline w={300}>{badge}</Tooltip> : badge;
}

export function ReturnStatusBadge({ status }: { status: string }) {
  const s = RETURN_STATUSES[status as keyof typeof RETURN_STATUSES] ?? { label: titleCase(status), color: "gray" };
  return <Badge color={s.color} size="sm">{s.label}</Badge>;
}

export function useStatuses() {
  return useQuery({
    queryKey: ["statuses"],
    queryFn: () => api<{ statuses: CustomStatus[] }>("/settings").then((r) => r.statuses),
    staleTime: 60_000,
  });
}

export function CustomStatusBadge({ statusId, statuses }: { statusId: number | null; statuses?: CustomStatus[] }) {
  if (!statusId) return <Text size="xs" c="dimmed">—</Text>;
  const s = statuses?.find((x) => x.id === statusId);
  if (!s) return null;
  return (
    <Badge color={s.color} size="sm" variant="light" radius="xl">
      {s.name}
    </Badge>
  );
}

export function RiskBadge({ flags, dismissed }: { flags: string[] | null; dismissed?: boolean }) {
  if (!flags?.length || dismissed) return null;
  return (
    <Tooltip
      multiline
      w={280}
      label={
        <Stack gap={2}>
          {flags.map((f) => (
            <Text key={f} size="xs">• {RISK_FLAGS[f] ?? f}</Text>
          ))}
        </Stack>
      }
    >
      <Badge color={flags.some((f) => f.startsWith("duplicate") || f === "blocked_customer") ? "red" : "orange"} size="sm" leftSection={<ShieldAlert size={11} />}>
        {flags.length} {flags.length === 1 ? "flag" : "flags"}
      </Badge>
    </Tooltip>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <Center py={60}>
      <Stack align="center" gap="xs">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">{label}</Text>
      </Stack>
    </Center>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert color="red" variant="light" icon={<AlertTriangle size={18} />} title="Could not load data" my="md">
      <Text size="sm">{error instanceof Error ? error.message : String(error)}</Text>
      {onRetry && (
        <Button size="xs" variant="white" color="red" mt="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Alert>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <Center py={56}>
      <Stack align="center" gap={8} maw={380}>
        <ThemeIcon size={44} radius="xl" variant="light" color="gray">
          {icon ?? <Inbox size={22} />}
        </ThemeIcon>
        <Text fw={600}>{title}</Text>
        {description && <Text size="sm" c="dimmed" ta="center">{description}</Text>}
        {action}
      </Stack>
    </Center>
  );
}

export function TableFooter({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  return (
    <Group justify="space-between" px="md" py="sm" style={{ borderTop: "1px solid var(--app-border)" }}>
      <Text size="sm" c="dimmed">
        {from}–{to} of {total.toLocaleString()}
      </Text>
      {pages > 1 && <Pagination size="sm" total={pages} value={page} onChange={onPage} siblings={1} />}
    </Group>
  );
}

export function Panel({ children, p = 0 }: { children: ReactNode; p?: number | string }) {
  return (
    <Paper className="app-panel" withBorder p={p} style={{ overflow: "hidden" }}>
      {children}
    </Paper>
  );
}

export function Copyable({ value, children }: { value: string; children?: ReactNode }) {
  return (
    <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
      {children ?? <Text className="mono">{value}</Text>}
      <CopyButton value={value} timeout={1500}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? "Copied" : "Copy"}>
            <ActionIcon size="xs" variant="subtle" color={copied ? "teal" : "gray"} onClick={copy} aria-label="Copy">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
    </Group>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group justify="space-between" gap="md" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>{label}</Text>
      <div style={{ textAlign: "right", minWidth: 0 }}>{typeof children === "string" || typeof children === "number" ? <Text size="sm">{children}</Text> : children}</div>
    </Group>
  );
}

function MapBadge({ map, value, size = "sm", variant = "light" }: { map: Record<string, { label: string; color: string }>; value: string; size?: "xs" | "sm" | "md"; variant?: string }) {
  const s = map[value] ?? { label: titleCase(value), color: "gray" };
  return <Badge color={s.color} size={size} variant={variant}>{s.label}</Badge>;
}

export const CallingBadge = ({ status, size }: { status: string; size?: "xs" | "sm" | "md" }) => <MapBadge map={CALLING_STATUSES} value={status} size={size} />;
export const LabelBadge = ({ status, size }: { status: string; size?: "xs" | "sm" | "md" }) => <MapBadge map={LABEL_STATUSES} value={status} size={size} variant="outline" />;
export const DispatchBadge = ({ status, size }: { status: string; size?: "xs" | "sm" | "md" }) => <MapBadge map={DISPATCH_STATUSES} value={status} size={size} variant="dot" />;
export function ShopifySyncBadge({ status, error }: { status: string; error?: string | null }) {
  if (status === "none") return null;
  const b = <MapBadge map={SHOPIFY_SYNC_STATUSES} value={status} size="sm" variant="outline" />;
  return error ? <Tooltip label={error} multiline w={300}>{b}</Tooltip> : b;
}

/** Today's business date in Asia/Dhaka (UTC+6, no DST). */
export const dhakaToday = (offsetDays = 0) => new Date(Date.now() + 6 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

/** Live mm:ss countdown to an ISO time. */
export function useCountdown(target: string | null | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [target]);
  if (!target) return null;
  const ms = Date.parse(target) - now;
  if (ms <= 0) return "booking…";
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function AutoBookChip({ at }: { at: string }) {
  const left = useCountdown(at);
  return (
    <Tooltip label="Auto-books with Steadfast when the timer ends. Open the order to cancel or book now.">
      <Badge size="sm" color="grape" variant="light" leftSection={<Timer size={11} />} style={{ fontVariantNumeric: "tabular-nums" }}>
        {left}
      </Badge>
    </Tooltip>
  );
}

/** New vs returning customer, with their delivery record. */
export function CustomerHistoryBadge({ orders, delivered, returned, flag }: { orders: number; delivered: number; returned: number; flag?: string | null }) {
  if (flag === "blocked") return <Badge size="xs" color="red">Blocked</Badge>;
  if (!orders) return <Badge size="xs" color="cyan" variant="light">New customer</Badge>;
  const finished = delivered + returned;
  const rate = finished ? Math.round((delivered / finished) * 100) : null;
  const color = rate === null ? "gray" : rate >= 80 ? "teal" : rate >= 50 ? "yellow" : "red";
  return (
    <Tooltip label={`${orders} previous order${orders === 1 ? "" : "s"} · ${delivered} delivered · ${returned} returned`}>
      <Badge size="xs" color={flag === "vip" ? "grape" : color} variant="light">
        {flag === "vip" ? "VIP · " : ""}Returning ×{orders}{rate !== null ? ` · ${rate}%` : ""}
      </Badge>
    </Tooltip>
  );
}
