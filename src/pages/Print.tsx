import { Box, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { Printer } from "lucide-react";
import { api } from "../api";
import { ErrorState, LoadingState } from "../components/ui";
import { day, money } from "../format";
import type { Booking, LineItem } from "../types";

type PrintOrder = {
  id: number;
  name: string;
  createdAt: string;
  lineItems: LineItem[];
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  booking: Booking;
  shopifyNote: string | null;
  consignment: { consignmentId: string | null; trackingCode: string | null; codAmount: number; invoice: string; note: string | null } | null;
};
type PrintData = { business: { name: string; phone: string; address: string }; orders: PrintOrder[] };

const pageStyle = { background: "#fff", color: "#111", boxShadow: "0 1px 4px rgba(0,0,0,.12)", margin: "0 auto 16px" } as const;

function Slip({ o, business }: { o: PrintOrder; business: PrintData["business"] }) {
  const b = o.booking;
  return (
    <div className="print-page" style={{ ...pageStyle, width: "148mm", minHeight: "210mm", padding: "10mm", fontSize: 12, fontFamily: "Inter, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div><div style={{ fontSize: 20, fontWeight: 700 }}>{business.name}</div><div>{business.phone}</div><div style={{ whiteSpace: "pre-wrap", color: "#555" }}>{business.address}</div></div>
        <div style={{ textAlign: "right" }}><div style={{ fontSize: 16, fontWeight: 700 }}>Packing slip</div><div>Order {o.name}</div><div>{day(o.createdAt)}</div></div>
      </div>
      <div style={{ marginTop: 16, padding: 10, border: "1px solid #ddd", borderRadius: 6 }}>
        <b>Ship to</b>
        <div>{b.recipientName} · {b.recipientPhone}</div>
        <div>{b.recipientAddress}</div>
        {o.consignment?.trackingCode && <div style={{ marginTop: 4 }}>Steadfast tracking: <b>{o.consignment.trackingCode}</b></div>}
      </div>
      <table style={{ width: "100%", marginTop: 16, borderCollapse: "collapse" }}>
        <thead><tr style={{ borderBottom: "2px solid #111", textAlign: "left" }}><th style={{ padding: 4 }}>✓</th><th>Item</th><th>SKU</th><th style={{ textAlign: "right" }}>Qty</th><th style={{ textAlign: "right" }}>Price</th></tr></thead>
        <tbody>
          {o.lineItems.map((li) => (
            <tr key={li.id} style={{ borderBottom: "1px solid #ddd" }}>
              <td style={{ padding: 6 }}>☐</td>
              <td>{li.title}{li.variantTitle ? <div style={{ color: "#555" }}>{li.variantTitle}</div> : null}</td>
              <td>{li.sku}</td>
              <td style={{ textAlign: "right", fontWeight: 700 }}>{li.quantity}</td>
              <td style={{ textAlign: "right" }}>{money(li.price * li.quantity, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10, marginLeft: "auto", width: 200 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>Subtotal</span><span>{money(o.subtotal, true)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between" }}><span>Shipping</span><span>{money(o.shipping, true)}</span></div>
        {o.discount > 0 && <div style={{ display: "flex", justifyContent: "space-between" }}><span>Discount</span><span>−{money(o.discount, true)}</span></div>}
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, borderTop: "1px solid #111", marginTop: 4, paddingTop: 4 }}><span>Total</span><span>{money(o.total, true)}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700 }}><span>COD</span><span>{money(o.consignment?.codAmount ?? b.codAmount, true)}</span></div>
      </div>
      {o.shopifyNote && <div style={{ marginTop: 16 }}><b>Customer note:</b> {o.shopifyNote}</div>}
      <div style={{ marginTop: 24, color: "#555", textAlign: "center" }}>Thank you for shopping with {business.name}!</div>
    </div>
  );
}

/** Printable A5 packing slips. Shipping labels are produced by the external label service. */
export default function Print() {
  const [params] = useSearchParams();
  const ids = params.get("ids") ?? "";
  const q = useQuery({ queryKey: ["print", ids], queryFn: () => api<PrintData>(`/orders/print?ids=${ids}`), enabled: Boolean(ids) });
  if (q.isLoading) return <LoadingState />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data;
  return (
    <Box p="md" style={{ background: "#eceef2", minHeight: "100vh" }}>
      <Paper className="no-print" p="md" mb="md" maw={760} mx="auto" withBorder>
        <Group justify="space-between">
          <Stack gap={2}>
            <Text fw={600}>{d?.orders.length ?? 0} packing slips (A5)</Text>
            <Text size="xs" c="dimmed">Set the printer paper size to A5, margins “None”.</Text>
          </Stack>
          <Button leftSection={<Printer size={15} />} onClick={() => window.print()}>Print</Button>
        </Group>
      </Paper>
      <style>{`@page { size: A5; margin: 0; }`}</style>
      {d?.orders.map((o) => <Slip key={o.id} o={o} business={d.business} />)}
    </Box>
  );
}
