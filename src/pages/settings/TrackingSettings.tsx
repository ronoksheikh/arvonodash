import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, Code, Group, List, Stack, Text, TextInput } from "@mantine/core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Globe, XCircle } from "lucide-react";
import { notifyError, notifySuccess, put } from "../../api";
import { useCan } from "../../auth";

type Check = { ok: boolean; message: string };

/** Settings → Tracking page: the public domain for customer links (e.g. track.arvono.store) and a live check. */
export function TrackingSettings({ trackingBaseUrl, storeUrl, instanceId, dashboardOrigin }: { trackingBaseUrl: string; storeUrl: string; instanceId: string; dashboardOrigin: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const disabled = !can("settings.manage");
  const [base, setBase] = useState(trackingBaseUrl);
  const [store, setStore] = useState(storeUrl);
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    setBase(trackingBaseUrl);
    setStore(storeUrl);
  }, [trackingBaseUrl, storeUrl]);

  const save = useMutation({
    mutationFn: () => put<{ settings: { trackingBaseUrl: string } }>("/settings", { trackingBaseUrl: base, storeUrl: store }),
    onSuccess: (r) => {
      if (base.trim() && !r.settings.trackingBaseUrl) notifyError(new Error("That address isn't a valid https domain"));
      else notifySuccess("Saved. New links use this address; the domain itself starts answering within a minute.");
      qc.invalidateQueries({ queryKey: ["settings"] });
    },
    onError: (e) => notifyError(e),
  });

  // Runs from the browser, so it also proves the HTTPS certificate is valid for customers.
  const runCheck = async () => {
    const url = (trackingBaseUrl || "").replace(/\/$/, "");
    if (!url) return;
    setChecking(true);
    try {
      const r = await fetch(`${url}/api/public/domain-check`, { cache: "no-store" });
      const j = (await r.json()) as { app?: string; instanceId?: string };
      if (j.app !== "arvono-tracking") setCheck({ ok: false, message: "The domain answers, but not with this app. Check the DNS record." });
      else if (j.instanceId !== instanceId) setCheck({ ok: false, message: "The domain reaches a different installation of this app." });
      else setCheck({ ok: true, message: "Working: DNS points here and HTTPS is valid." });
    } catch {
      setCheck({ ok: false, message: "Couldn't reach it over HTTPS. DNS may still be propagating, or the custom domain isn't added to the Worker yet." });
    } finally {
      setChecking(false);
    }
  };

  const host = (() => {
    try {
      return trackingBaseUrl ? new URL(trackingBaseUrl).host : "track.arvono.store";
    } catch {
      return "track.arvono.store";
    }
  })();

  return (
    <Stack maw={820}>
      <Card>
        <Group gap={8} mb={4}><Globe size={18} /><Text fw={600}>Customer tracking domain</Text></Group>
        <Text size="sm" c="dimmed" mb="md">
          Every customer link — in SMS, on labels and copied from an order — uses this address. Leave it empty to use the dashboard's address ({dashboardOrigin}).
          On this domain only tracking pages open; the dashboard, login and API are not reachable there.
        </Text>
        <Group align="flex-end">
          <TextInput label="Tracking address" placeholder="https://track.arvono.store" value={base} onChange={(e) => setBase(e.currentTarget.value)} disabled={disabled} style={{ flex: 1 }} />
          <TextInput label="Store website" placeholder="https://arvono.store" value={store} onChange={(e) => setStore(e.currentTarget.value)} disabled={disabled} style={{ flex: 1 }} />
        </Group>
        <Text size="xs" c="dimmed" mt={4}>The store website is where the logo and "Continue shopping" go, and where the bare tracking domain redirects.</Text>
        <Group justify="space-between" mt="md">
          <Group gap="xs">
            {trackingBaseUrl && <Button variant="default" size="xs" loading={checking} onClick={runCheck}>Check domain</Button>}
            {check && <Badge color={check.ok ? "teal" : "red"} leftSection={check.ok ? <CheckCircle2 size={11} /> : <XCircle size={11} />}>{check.ok ? "Working" : "Not working"}</Badge>}
          </Group>
          {!disabled && <Button size="xs" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>}
        </Group>
        {check && <Alert mt="sm" color={check.ok ? "teal" : "orange"} variant="light">{check.message}</Alert>}
      </Card>

      <Card>
        <Text fw={600} mb="xs">Set up {host} (one time)</Text>
        <Text size="sm" fw={500} mt="xs">If arvono.store's DNS is on Cloudflare (recommended)</Text>
        <List size="sm" spacing={4} mt={4}>
          <List.Item>Cloudflare dashboard → Workers & Pages → this Worker → Settings → Domains & Routes → Add → Custom domain → <Code>{host}</Code>.</List.Item>
          <List.Item>Cloudflare creates the DNS record and the HTTPS certificate itself (a few minutes). Or uncomment the <Code>routes</Code> line in <Code>wrangler.jsonc</Code> and deploy.</List.Item>
        </List>
        <Text size="sm" fw={500} mt="sm">If the DNS stays at Shopify or another provider</Text>
        <List size="sm" spacing={4} mt={4}>
          <List.Item>A plain CNAME to <Code>*.workers.dev</Code> does not work. Move arvono.store's nameservers to Cloudflare (free plan; the Shopify store keeps working with the same records), or</List.Item>
          <List.Item>use Cloudflare for SaaS custom hostnames on a Cloudflare zone, then add a CNAME <Code>track</Code> → your fallback hostname at your DNS provider.</List.Item>
        </List>
        <Text size="sm" mt="sm">Then save <Code>https://{host}</Code> above and press Check domain.</Text>
        {trackingBaseUrl && (
          <Button component="a" href={trackingBaseUrl} target="_blank" rel="noreferrer" variant="subtle" size="xs" mt="sm" leftSection={<ExternalLink size={13} />}>Open {host}</Button>
        )}
      </Card>
    </Stack>
  );
}
