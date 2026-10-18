import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler } from "./api";
import type { Permission } from "../shared/constants";

export type Me = { id: number; email: string; name: string; role: string; permissions: string[] };

const AuthContext = createContext<{ user: Me | null; loading: boolean; refresh: () => Promise<unknown> }>({
  user: null,
  loading: true,
  refresh: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [expired, setExpired] = useState(false);
  const me = useQuery({
    queryKey: ["me"],
    queryFn: () => api<{ user: Me | null }>("/auth/me").then((r) => r.user).catch(() => null),
    staleTime: 5 * 60_000,
  });
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setExpired(true);
      qc.setQueryData(["me"], null);
    });
  }, [qc]);
  useEffect(() => {
    if (me.data) setExpired(false);
  }, [me.data]);
  return (
    <AuthContext.Provider value={{ user: expired ? null : (me.data ?? null), loading: me.isLoading, refresh: () => me.refetch() }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

export function useCan() {
  const { user } = useAuth();
  return (perm: Permission) => Boolean(user?.permissions.includes(perm));
}
