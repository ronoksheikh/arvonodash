import type { ReactNode } from "react";
import { Alert, Badge, Button, Center, Group, Loader, Pagination, Paper, Stack, Text, ThemeIcon, Title, Tooltip, CopyButton, ActionIcon } from "@mantine/core";
import { AlertTriangle, Check, Copy, Inbox, ShieldAlert } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { COURIER_STAGES, FULFILLMENT_STATES, RISK_FLAGS, STEADFAST_STATUSES, RETURN_STATUSES } from "../../shared/constants";
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
