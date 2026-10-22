import { Fragment, type ReactNode } from "react";
import { Group, Text, Tooltip } from "@mantine/core";
import { ChevronRight } from "lucide-react";
import { COURIERS, type CourierId } from "../../shared/couriers";

/**
 * One status line for an order instead of five badges:
 * "Confirmed → Booked (Carrybee) → Packed → With rider". Earlier steps are quiet, the current step is
 * coloured, problems (failed Shopify update, cancelled after booking…) get their own red line.
 */

export type ProgressOrder = {
  callingStatus: string;
  callAttempts: number;
  courierStage: string;
  courier?: string | null;
  labelStatus: string;
  dispatchStatus: string;
  handedOverAt?: string | null;
  cancelledAt: string | null;
  cancelRequestedAt?: string | null;
  fulfillmentState: string;
  fulfillmentError?: string | null;
  shopifySyncStatus: string;
  shopifySyncError?: string | null;
  financialStatus?: string | null;
};

type Step = { label: string; color: string; hint?: string };

const CALLING: Record<string, Step> = {
  not_called: { label: "New · not called", color: "gray" },
  no_answer: { label: "No answer", color: "yellow" },
  call_again: { label: "Call back", color: "orange" },
  confirmed: { label: "Confirmed", color: "teal" },
  rejected: { label: "Rejected on call", color: "red" },
};

const COURIER_STEP: Record<string, Step> = {
  in_transit: { label: "In transit", color: "indigo" },
  on_hold: { label: "On hold", color: "yellow", hint: "The courier is holding the parcel — check the Courier tab" },
  awaiting_confirmation: { label: "Awaiting courier confirmation", color: "cyan" },
  delivered: { label: "Delivered", color: "teal" },
  partial_delivered: { label: "Partly delivered", color: "lime" },
  returned: { label: "Returned", color: "red" },
  cancelled: { label: "Cancelled at courier", color: "dark" },
  issue: { label: "Needs support", color: "orange" },
};

const FINAL = ["delivered", "partial_delivered", "returned", "cancelled"];

export function progressSteps(o: ProgressOrder): { steps: Step[]; problems: Step[] } {
  const steps: Step[] = [];
  const problems: Step[] = [];
  const booked = o.courierStage !== "unbooked";
  const calling = CALLING[o.callingStatus] ?? { label: o.callingStatus, color: "gray" };
  if (o.financialStatus === "paid" && !booked && o.callingStatus === "not_called") steps.push({ label: "Prepaid", color: "teal" });
  else steps.push(o.callingStatus === "no_answer" && o.callAttempts > 1 ? { ...calling, label: `No answer ×${o.callAttempts}` } : calling);

  if (booked) {
    const name = COURIERS[o.courier as CourierId]?.label;
    steps.push({ label: name ? `Booked (${name})` : "Booked", color: "blue" });
    const pickedUp = o.dispatchStatus === "dispatched" || !["booked", "unbooked"].includes(o.courierStage);
    if (!pickedUp) {
      if (o.labelStatus === "printed") steps.push({ label: "Printed", color: "blue" });
      if (o.dispatchStatus === "sorted") steps.push({ label: "Packed", color: "indigo" });
      if (o.handedOverAt) steps.push({ label: "With rider", color: "indigo" });
    } else if (o.courierStage === "booked") {
      steps.push({ label: "Picked up", color: "indigo" });
    }
    if (COURIER_STEP[o.courierStage]) steps.push(COURIER_STEP[o.courierStage]);
  }

  if (o.cancelledAt) {
    if (!booked || FINAL.includes(o.courierStage)) steps.push({ label: "Cancelled", color: "dark" });
    else problems.push({ label: "Cancelled in Shopify — stop the parcel", color: "red" });
  } else if (o.cancelRequestedAt) {
    problems.push({ label: "Cancelling in Shopify…", color: "gray" });
  }
  if (o.fulfillmentState === "failed") problems.push({ label: "Shopify fulfillment failed", color: "red", hint: o.fulfillmentError ?? undefined });
  if (o.shopifySyncStatus === "failed") problems.push({ label: "Shopify update failed", color: "red", hint: o.shopifySyncError ?? undefined });
  return { steps, problems };
}

/**
 * `first` replaces the first step (e.g. the calling menu while the order can still be called).
 * `size` "md" is used in the order drawer header.
 */
export function OrderProgress({ order, first, size = "sm" }: { order: ProgressOrder; first?: ReactNode; size?: "sm" | "md" }) {
  const { steps, problems } = progressSteps(order);
  const fs = size === "md" ? "sm" : "xs";
  return (
    <div>
      <Group gap={2} wrap="wrap" align="center" style={{ rowGap: 2 }}>
        {steps.map((s, i) => {
          const last = i === steps.length - 1;
          // Grey/dark steps use the normal text colour so they stay readable in dark mode.
          const neutral = s.color === "gray" || s.color === "dark";
          const node =
            i === 0 && first ? (
              first
            ) : (
              <Text
                size={fs}
                fw={last ? 600 : 400}
                c={!last ? "dimmed" : neutral ? undefined : `var(--mantine-color-${s.color}-light-color)`}
                style={{ whiteSpace: "nowrap", ...(last ? { background: neutral ? "var(--app-muted-bg)" : `var(--mantine-color-${s.color}-light)`, padding: "1px 7px", borderRadius: 6 } : {}) }}
              >
                {s.label}
              </Text>
            );
          return (
            <Fragment key={`${s.label}-${i}`}>
              {i > 0 && <ChevronRight size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />}
              {s.hint ? <Tooltip label={s.hint} multiline maw={280}><span>{node}</span></Tooltip> : node}
            </Fragment>
          );
        })}
      </Group>
      {problems.map((p) => (
        <Tooltip key={p.label} label={p.hint} disabled={!p.hint} multiline maw={300}>
          <Text size="xs" c={p.color === "red" ? "red.7" : "dimmed"} fw={500} mt={2}>⚠ {p.label}</Text>
        </Tooltip>
      ))}
    </div>
  );
}
