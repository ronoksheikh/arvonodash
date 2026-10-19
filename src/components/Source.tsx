import { Anchor, Badge, Card, Group, SimpleGrid, Stack, Text, Tooltip } from "@mantine/core";
import { Megaphone } from "lucide-react";
import { CHANNELS, type Attribution, type Channel, type Visit } from "../../shared/attribution";
import { dateTime } from "../format";

/** Where an order came from: compact badge for lists, full card for the order drawer. */

export function channelInfo(channel: string | null | undefined) {
  return CHANNELS[(channel ?? "unknown") as Channel] ?? { label: channel ?? "Unknown", color: "gray" };
}

export function SourceBadge({ channel, campaign, source, medium }: { channel: string | null; campaign?: string | null; source?: string | null; medium?: string | null }) {
  const c = channelInfo(channel);
  const utm = [source && `source: ${source}`, medium && `medium: ${medium}`, campaign && `campaign: ${campaign}`].filter(Boolean).join(" · ");
  return (
    <Tooltip label={utm || "No UTM tags"} disabled={!utm} multiline maw={320}>
      <div style={{ minWidth: 0 }}>
        <Badge size="sm" variant="light" color={c.color} style={{ maxWidth: "none" }}>{c.label}</Badge>
        {campaign && <Text size="xs" c="dimmed" lineClamp={1} maw={170}>{campaign}</Text>}
      </div>
    </Tooltip>
  );
}

const pretty = (url: string | null) => {
  if (!url) return null;
  try {
    const u = new URL(url, "https://shop.local");
    return u.hostname === "shop.local" ? u.pathname : `${u.hostname.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

function VisitBlock({ title, visit }: { title: string; visit: Visit }) {
  const rows: [string, string | null][] = [
    ["Source", visit.sourceDescription || visit.source],
    ["Type", visit.sourceType],
    ["UTM source", visit.utm?.source ?? null],
    ["UTM medium", visit.utm?.medium ?? null],
    ["UTM campaign", visit.utm?.campaign ?? null],
    ["UTM content", visit.utm?.content ?? null],
    ["UTM term", visit.utm?.term ?? null],
  ];
  return (
    <div style={{ padding: 10, borderRadius: 10, background: "var(--app-muted-bg)", minWidth: 0 }}>
      <Text size="xs" fw={700} mb={4}>{title}{visit.occurredAt ? <Text span size="xs" c="dimmed" fw={400}> · {dateTime(visit.occurredAt)}</Text> : null}</Text>
      <Stack gap={2}>
        {rows.filter(([, v]) => v).map(([k, v]) => (
          <Text key={k} size="xs"><Text span c="dimmed">{k}: </Text>{v}</Text>
        ))}
        {visit.referrerUrl && <Text size="xs" lineClamp={1}><Text span c="dimmed">From: </Text><Anchor href={visit.referrerUrl} target="_blank" rel="noreferrer" size="xs">{pretty(visit.referrerUrl)}</Anchor></Text>}
        {visit.landingPage && <Text size="xs" lineClamp={2} style={{ wordBreak: "break-all" }}><Text span c="dimmed">Landed on: </Text>{pretty(visit.landingPage)}</Text>}
      </Stack>
    </div>
  );
}

const FROM_LABEL: Record<Attribution["from"], string> = {
  journey: "Shopify customer journey",
  web: "landing page of the order",
  attributes: "UTM tags saved at checkout",
  none: "no visit data",
};

export function SourceCard({ channel, sourceName, attribution }: { channel: string | null; sourceName: string | null; attribution: Attribution | null }) {
  const c = channelInfo(channel);
  const a = attribution;
  const sameVisit = a?.firstVisit && a.lastVisit && JSON.stringify(a.firstVisit) === JSON.stringify(a.lastVisit);
  return (
    <Card padding="md">
      <Group justify="space-between" mb="sm">
        <Group gap={6}><Megaphone size={15} /><Text fw={600} size="sm">Where this order came from</Text></Group>
        <Badge variant="light" color={c.color}>{c.label}</Badge>
      </Group>
      {!a || (!a.firstVisit && !a.lastVisit) ? (
        <Text size="sm" c="dimmed">
          {channel === "draft_order" ? "Created by staff in Shopify (draft order)." : channel === "pos" ? "Sold at the point of sale." : "Shopify has no visit data for this order yet. It is filled in automatically within a few minutes of checkout."}
        </Text>
      ) : (
        <>
          <SimpleGrid cols={{ base: 1, xs: sameVisit || !a.firstVisit || !a.lastVisit ? 1 : 2 }} spacing="xs">
            {a.firstVisit && !sameVisit && <VisitBlock title="First visit" visit={a.firstVisit} />}
            {a.lastVisit && <VisitBlock title={a.firstVisit && !sameVisit ? "Last visit (gets the credit)" : "Visit"} visit={a.lastVisit} />}
          </SimpleGrid>
          <Text size="xs" c="dimmed" mt="xs">
            {[
              a.customerOrderIndex ? (a.customerOrderIndex === 1 ? "Customer's first order" : `Customer's order #${a.customerOrderIndex}`) : null,
              a.daysToConversion !== null ? (a.daysToConversion === 0 ? "bought the same day" : `${a.daysToConversion} day(s) from first visit to order`) : null,
              `from the ${FROM_LABEL[a.from]}`,
              sourceName && sourceName !== "web" ? `Shopify channel: ${sourceName}` : null,
            ].filter(Boolean).join(" · ")}
          </Text>
        </>
      )}
    </Card>
  );
}
