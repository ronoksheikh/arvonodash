import { Anchor, Badge, Button, Card, Group, Progress, RingProgress, SimpleGrid, Stack, Table, Text, ThemeIcon, Tooltip } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { Link } from "react-router";
import { History, MapPin, Megaphone, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion, Truck } from "lucide-react";
import { notifyError, post } from "../api";
import { useCan } from "../auth";
import { ago, dateShort, money } from "../format";
import { FraudCard } from "./Fraud";
import { PREVIOUS_OUTCOMES, RISK_GROUPS, RISK_LEVELS, type GroupStat, type RiskFactor, type RiskGroup } from "../../shared/risk";
import type { OrderDetail, RiskSummary } from "../types";

/** Smart risk score: list chip, drawer banner and the Risk tab. */

const ICON = { low: ShieldCheck, medium: ShieldQuestion, high: ShieldAlert } as const;
const pct = (v: number) => `${Math.round(v * 100)}%`;

function FactorLine({ f, compact }: { f: Pick<RiskFactor, "label" | "points"> & { detail?: string | null }; compact?: boolean }) {
  const up = f.points > 0;
  return (
    <Group gap={8} wrap="nowrap" align="flex-start">
      <Text size="xs" fw={700} c={up ? "red.7" : "teal.7"} w={30} ta="right" style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
        {up ? "+" : "−"}{Math.abs(f.points)}
      </Text>
      <div style={{ minWidth: 0 }}>
        <Text size={compact ? "xs" : "sm"} fw={compact ? 400 : 500}>{f.label}</Text>
        {!compact && f.detail && <Text size="xs" c="dimmed" style={{ wordBreak: "break-word" }}>{f.detail}</Text>}
      </div>
    </Group>
  );
}

/** Compact score chip for the orders table; the tooltip explains the number. */
export function RiskPill({ risk }: { risk: RiskSummary | null }) {
  if (!risk) return null;
  const lv = RISK_LEVELS[risk.level];
  const Icon = ICON[risk.level];
  return (
    <Tooltip
      multiline
      w={300}
      withArrow
      label={
        <Stack gap={4}>
          <Text size="xs" fw={700}>Risk {risk.score}/100 · {lv.label}</Text>
          <Text size="xs">{lv.hint}</Text>
          {risk.factors.slice(0, 5).map((f) => (
            <Text key={f.key} size="xs">{f.points > 0 ? `+${f.points}` : `−${Math.abs(f.points)}`} · {f.label}</Text>
          ))}
        </Stack>
      }
    >
      <Badge
        size="sm"
        color={lv.color}
        variant={risk.level === "high" ? "filled" : "light"}
        leftSection={<Icon size={11} />}
        style={{ fontVariantNumeric: "tabular-nums", flexShrink: 0 }}
      >
        {risk.score} · {lv.label}
      </Badge>
    </Tooltip>
  );
}

function GroupTile({ icon: Icon, title, stat, label, min }: { icon: typeof Megaphone; title: string; stat: GroupStat | null; label: string | null; min: number }) {
  const enough = stat && stat.finished >= min;
  const worse = stat ? stat.rate - stat.shopRate : 0;
  const color = !enough ? "gray" : worse >= 0.05 ? "red" : worse <= -0.08 ? "teal" : "gray";
  return (
    <Card withBorder padding="sm">
      <Group gap={6} mb={6} wrap="nowrap"><Icon size={14} /><Text size="xs" c="dimmed" fw={500}>{title}</Text></Group>
      <Text size="sm" fw={600} style={{ wordBreak: "break-word" }}>{label ?? "—"}</Text>
      {stat ? (
        <>
          <Group gap={6} mt={4} align="baseline">
            <Text fw={800} size="lg" c={color === "gray" ? undefined : `${color}.7`} style={{ fontVariantNumeric: "tabular-nums" }}>{pct(stat.rate)}</Text>
            <Text size="xs" c="dimmed">returned · shop {pct(stat.shopRate)}</Text>
          </Group>
          <Progress.Root size={6} mt={4}>
            <Progress.Section value={Math.min(100, stat.rate * 100)} color={color === "gray" ? "blue" : color} />
          </Progress.Root>
          <Text size="xs" c="dimmed" mt={4}>{stat.finished} finished order{stat.finished === 1 ? "" : "s"}{enough ? "" : ` · needs ${min} to count`}</Text>
        </>
      ) : (
        <Text size="xs" c="dimmed" mt={4}>{label ? "No finished orders yet" : "Not known for this order"}</Text>
      )}
    </Card>
  );
}

export function RiskTab({ d, refresh }: { d: OrderDetail; refresh: () => void }) {
  const can = useCan();
  const r = d.risk;
  const o = d.order;
  const lv = RISK_LEVELS[r.level];
  const recheck = useMutation({ mutationFn: () => post(`/orders/${o.id}/recheck-risk`), onSuccess: refresh, onError: (e) => notifyError(e) });
  const groups = (Object.keys(RISK_GROUPS) as RiskGroup[]).map((g) => ({ g, items: r.factors.filter((f) => f.group === g) })).filter((x) => x.items.length);
  const prev = r.previous;
  const count = (k: string[]) => prev.filter((p) => k.includes(p.outcome)).length;
  const otherNames = new Set(prev.filter((p) => !p.sameName && p.customerName).map((p) => p.customerName!.trim()));
  const up = r.factors.filter((f) => f.points > 0).reduce((s, f) => s + f.points, 0);
  const down = r.factors.filter((f) => f.points < 0).reduce((s, f) => s + f.points, 0);

  return (
    <Stack gap="lg">
      <Card withBorder padding="md" style={{ borderLeft: `4px solid var(--mantine-color-${lv.color}-6)` }}>
        <Group justify="space-between" align="flex-start" wrap="nowrap">
          <Group gap="md" wrap="nowrap">
            <RingProgress
              size={96}
              thickness={9}
              roundCaps
              sections={[{ value: Math.max(3, r.score), color: lv.color }]}
              label={
                <Stack gap={0} align="center">
                  <Text fw={800} size="xl" lh={1} style={{ fontVariantNumeric: "tabular-nums" }}>{r.score}</Text>
                  <Text size="xs" c="dimmed">/ 100</Text>
                </Stack>
              }
            />
            <div>
              <Text size="xs" c="dimmed" fw={500}>Smart risk score</Text>
              <Text fw={800} size="xl" c={`${lv.color}.7`}>{lv.label}</Text>
              <Text size="sm" fw={500}>{r.headline}</Text>
              <Text size="xs" c="dimmed" mt={2}>{lv.hint}</Text>
            </div>
          </Group>
          {can("orders.edit") && (
            <Button size="compact-xs" variant="subtle" leftSection={<RefreshCw size={12} />} loading={recheck.isPending} onClick={() => recheck.mutate()}>Re-check</Button>
          )}
        </Group>
        <Group gap="lg" mt="sm">
          <Text size="xs" c="dimmed">Start 20</Text>
          <Text size="xs" c="red.7">Warning signs +{up}</Text>
          <Text size="xs" c="teal.7">Good signs −{Math.abs(down)}</Text>
          <Text size="xs" c="dimmed">0–34 Safe · 35–59 Check · 60+ Risky · updated {ago(r.computedAt)}</Text>
        </Group>
      </Card>

      <Card withBorder padding="md">
        <Text fw={600} size="sm" mb="sm">Why this score</Text>
        {groups.length === 0 ? (
          <Text size="sm" c="dimmed">No signs either way yet — a first order with nothing unusual.</Text>
        ) : (
          <Stack gap="md">
            {groups.map(({ g, items }) => (
              <div key={g}>
                <Text size="xs" c="dimmed" fw={600} tt="uppercase" mb={4}>{RISK_GROUPS[g]}</Text>
                <Stack gap={6}>{items.map((f) => <FactorLine key={f.key} f={f} />)}</Stack>
              </div>
            ))}
          </Stack>
        )}
      </Card>

      <Card withBorder padding={0}>
        <Group justify="space-between" p="md" pb="xs">
          <Group gap={6}><History size={15} /><Text fw={600} size="sm">This number's order history</Text><Text size="xs" c="dimmed" className="mono">{o.phone ?? "no valid phone"}</Text></Group>
        </Group>
        {prev.length === 0 ? (
          <Text size="sm" c="dimmed" px="md" pb="md">First order from this number.</Text>
        ) : (
          <>
            <Group gap={6} px="md" pb="sm">
              <Badge variant="light" color="gray">{prev.length} other order{prev.length === 1 ? "" : "s"}</Badge>
              {count(["delivered", "partial"]) > 0 && <Badge variant="light" color="teal">{count(["delivered", "partial"])} received</Badge>}
              {count(["returned"]) > 0 && <Badge variant="light" color="red">{count(["returned"])} returned</Badge>}
              {count(["cancelled", "rejected", "cancelled_at_courier"]) > 0 && <Badge variant="light" color="dark">{count(["cancelled", "rejected", "cancelled_at_courier"])} cancelled</Badge>}
              {count(["in_progress", "open"]) > 0 && <Badge variant="light" color="indigo">{count(["in_progress", "open"])} open</Badge>}
              {otherNames.size > 0 && (
                <Tooltip label={[...otherNames].join(", ")}><Badge variant="light" color="orange">{otherNames.size} other name{otherNames.size === 1 ? "" : "s"}</Badge></Tooltip>
              )}
            </Group>
            <Table.ScrollContainer minWidth={560}>
              <Table className="app-table" verticalSpacing={6}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th pl="md">Order</Table.Th>
                    <Table.Th>Name on order</Table.Th>
                    <Table.Th>What happened</Table.Th>
                    <Table.Th ta="right" pr="md">Total</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {prev.map((p) => {
                    const out = PREVIOUS_OUTCOMES[p.outcome];
                    return (
                      <Table.Tr key={p.id} style={{ cursor: "default" }}>
                        <Table.Td pl="md">
                          <Group gap={6} wrap="nowrap">
                            <Anchor component={Link} to={`/orders?open=${p.id}`} size="sm" fw={600}>{p.name}</Anchor>
                            {p.id === o.duplicateOfOrderId && <Badge size="xs" color="red">possible duplicate</Badge>}
                          </Group>
                          <Text size="xs" c="dimmed">{dateShort(p.shopCreatedAt)} · {ago(p.shopCreatedAt)}</Text>
                        </Table.Td>
                        <Table.Td>
                          <Text size="sm">{p.customerName ?? "—"}</Text>
                          <Group gap={4}>
                            {!p.sameName && <Badge size="xs" variant="light" color="orange">different name</Badge>}
                            {!p.sameAddress && <Tooltip label={p.address || "No address"} multiline maw={280}><Badge size="xs" variant="light" color="gray" leftSection={<MapPin size={9} />}>other address</Badge></Tooltip>}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Badge size="sm" variant="light" color={out.color}>{out.label}</Badge>
                          {p.cancelReason && (p.outcome === "cancelled" || p.outcome === "rejected") && <Text size="xs" c="dimmed">{p.cancelReason}</Text>}
                          {p.nearby && (p.outcome === "cancelled" || p.outcome === "rejected") && <Text size="xs" c="dimmed">placed close to this order</Text>}
                        </Table.Td>
                        <Table.Td ta="right" pr="md"><Text size="sm" style={{ fontVariantNumeric: "tabular-nums" }}>{money(p.total)}</Text></Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </>
        )}
      </Card>

      <div>
        <Group gap={6} mb="xs"><Truck size={15} /><Text fw={600} size="sm">Courier record</Text></Group>
        <FraudCard orderId={o.id} fraud={d.fraud} onChecked={refresh} />
      </div>

      <div>
        <Text fw={600} size="sm" mb="xs">Return rates (last 180 days)</Text>
        <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
          <GroupTile icon={Megaphone} title="Ad / source" stat={r.channel} label={r.channel?.label ?? null} min={15} />
          <GroupTile icon={Megaphone} title="Campaign" stat={r.campaign} label={o.utmCampaign} min={10} />
          <GroupTile icon={MapPin} title="District / city" stat={r.district} label={o.city} min={10} />
        </SimpleGrid>
      </div>
      <Group gap={6}>
        <ThemeIcon size="sm" variant="light" color="gray"><ShieldQuestion size={12} /></ThemeIcon>
        <Text size="xs" c="dimmed">The score is advice for the calling team — it never cancels or blocks an order by itself. High scores appear in the “Call first” tab.</Text>
      </Group>
    </Stack>
  );
}
