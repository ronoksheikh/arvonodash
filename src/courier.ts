import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { COURIERS, type CourierId } from "../shared/couriers";

/** Name of the courier new bookings go to (Settings → Connections → Courier for new bookings). */
export function useBookingCourier() {
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<{ settings: { courier: CourierId } }>("/settings"), staleTime: 60_000 });
  return COURIERS[q.data?.settings.courier ?? "steadfast"] ?? COURIERS.steadfast;
}
