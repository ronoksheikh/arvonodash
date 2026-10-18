import { useEffect, useState } from "react";
import { Alert, AppShell, Avatar, Burger, Group, Menu, NavLink, ScrollArea, Stack, Text, TextInput, ActionIcon, useMantineColorScheme, useComputedColorScheme, Tooltip, Badge, Box, UnstyledButton } from "@mantine/core";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { NavLink as RouterLink, Outlet, useLocation, useNavigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LayoutDashboard, Printer, PackageCheck, ScanLine, AlarmClock, AlertOctagon, BarChart3, ShoppingBag, Truck, Undo2, Users, Wallet, History, RefreshCw, Settings, Moon, Sun, Search, LogOut, ChevronDown,
} from "lucide-react";
import { api, post } from "../api";
import { useAuth } from "../auth";
import type { Permission } from "../../shared/constants";

const NAV: { to: string; label: string; icon: typeof LayoutDashboard; perm?: Permission; badgeKey?: string }[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, perm: "orders.view" },
  { to: "/report", label: "Owner report", icon: BarChart3, perm: "reports.view" },
  { to: "/orders", label: "Orders", icon: ShoppingBag, perm: "orders.view", badgeKey: "unbooked" },
  { to: "/print-queue", label: "Ready to print", icon: Printer, perm: "orders.view" },
  { to: "/dispatch", label: "Dispatch", icon: PackageCheck, perm: "orders.view" },
  { to: "/scan", label: "Scan & sort", icon: ScanLine, perm: "dispatch.manage" },
  { to: "/pickup", label: "Pickup today", icon: AlarmClock, perm: "orders.view" },
  { to: "/stuck", label: "Stuck parcels", icon: AlertOctagon, perm: "orders.view", badgeKey: "stuck" },
  { to: "/consignments", label: "Consignments", icon: Truck, perm: "orders.view" },
  { to: "/returns", label: "Returns", icon: Undo2, perm: "orders.view" },
  { to: "/customers", label: "Customers", icon: Users, perm: "orders.view" },
  { to: "/cod", label: "COD & Settlements", icon: Wallet, perm: "cod.view" },
];
const NAV_SYSTEM: typeof NAV = [
  { to: "/activity", label: "Activity log", icon: History, perm: "logs.view" },
  { to: "/sync", label: "Sync & webhooks", icon: RefreshCw, perm: "logs.view" },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme("light");
  const [search, setSearch] = useState("");
  useHotkeys([["mod+K", () => document.getElementById("global-search")?.focus()]]);

  // Pull the latest from Shopify whenever the dashboard opens or refreshes, then every minute
  // while visible. Webhooks still do the real-time work; this catches anything they miss.
  useEffect(() => {
    if (!user?.permissions.includes("orders.view")) return;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      post("/orders/sync-now")
        .then(() => {
          qc.invalidateQueries({ queryKey: ["orders"] });
          qc.invalidateQueries({ queryKey: ["nav-counts"] });
          qc.invalidateQueries({ queryKey: ["dashboard"] });
        })
        .catch(() => {});
    };
    run();
    const t = setInterval(run, 60_000);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", run);
    };
  }, [user, qc]);

  const counts = useQuery({
    queryKey: ["nav-counts"],
    queryFn: () =>
      api<{ pipeline: { toCall: number; readyToBook: number; attention: number; stuck: number }; steadfastPause: { until: string; reason: string; message: string } | null }>("/dashboard?days=7"),
    refetchInterval: 60_000,
    enabled: Boolean(user?.permissions.includes("orders.view")),
  });

  const can = (p?: Permission) => !p || user?.permissions.includes(p);
  const renderLink = (item: (typeof NAV)[number]) =>
    can(item.perm) && (
      <NavLink
        key={item.to}
        component={RouterLink}
        to={item.to}
        end={item.to === "/"}
        label={item.label}
        leftSection={<item.icon size={17} strokeWidth={1.8} />}
        className="nav-link"
        onClick={close}
        active={item.to === "/" ? location.pathname === "/" : location.pathname.startsWith(item.to)}
        rightSection={
          item.badgeKey === "stuck" && counts.data?.pipeline.stuck ? (
            <Tooltip label={`${counts.data.pipeline.stuck} parcel(s) need a call`}>
              <Badge size="xs" variant="filled" color="red">{counts.data.pipeline.stuck}</Badge>
            </Tooltip>
          ) : item.badgeKey === "unbooked" && counts.data && counts.data.pipeline.toCall + counts.data.pipeline.readyToBook > 0 ? (
            <Tooltip label={`${counts.data.pipeline.toCall} to call · ${counts.data.pipeline.readyToBook} ready to book`}>
              <Badge size="xs" variant="filled">{counts.data.pipeline.toCall + counts.data.pipeline.readyToBook}</Badge>
            </Tooltip>
          ) : null
        }
        styles={{ root: { borderRadius: 8, padding: "7px 10px" }, label: { fontSize: 14 } }}
      />
    );

  const logout = async () => {
    await post("/auth/logout");
    qc.clear();
    window.location.href = "/login";
  };

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 248, breakpoint: "sm", collapsed: { mobile: !opened } }}
      padding={{ base: "md", sm: "xl" }}
      styles={{
        header: { borderColor: "var(--app-border)", background: "var(--app-surface)" },
        navbar: { borderColor: "var(--app-border)", background: "var(--app-surface)" },
        main: { background: "var(--app-bg)" },
      }}
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <UnstyledButton onClick={() => navigate("/")}>
              <Group gap={10} wrap="nowrap">
                <Box w={30} h={30} style={{ borderRadius: 8, background: "var(--mantine-color-brand-6)", display: "grid", placeItems: "center" }}>
                  <svg width="16" height="16" viewBox="0 0 32 32"><path d="M5 27 16 4l11 23h-5.2L16 15.2 10.2 27z" fill="#fff" /></svg>
                </Box>
                <Stack gap={0} visibleFrom="xs">
                  <Text fw={700} size="sm" lh={1.1} style={{ letterSpacing: 0.4 }}>ARVONO</Text>
                  <Text size="xs" c="dimmed" lh={1.1}>Fulfillment OS</Text>
                </Stack>
              </Group>
            </UnstyledButton>
          </Group>
          <form
            style={{ flex: 1, maxWidth: 420 }}
            onSubmit={(e) => {
              e.preventDefault();
              navigate(`/orders?search=${encodeURIComponent(search.trim())}`);
              setSearch("");
            }}
          >
            <TextInput
              id="global-search"
              placeholder="Search order, phone, tracking…"
              leftSection={<Search size={15} />}
              rightSection={<Text size="xs" c="dimmed" visibleFrom="md" pr={8}>⌘K</Text>}
              rightSectionWidth={44}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              radius="md"
              visibleFrom="xs"
            />
          </form>
          <Group gap="xs" wrap="nowrap">
            <Tooltip label={scheme === "dark" ? "Light mode" : "Dark mode"}>
              <ActionIcon variant="default" size="lg" onClick={() => setColorScheme(scheme === "dark" ? "light" : "dark")} aria-label="Toggle color scheme">
                {scheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
              </ActionIcon>
            </Tooltip>
            <Menu position="bottom-end" width={220}>
              <Menu.Target>
                <UnstyledButton>
                  <Group gap={8} wrap="nowrap">
                    <Avatar size={32} radius="xl" color="brand">{user?.name.slice(0, 1).toUpperCase()}</Avatar>
                    <Stack gap={0} visibleFrom="md">
                      <Text size="sm" fw={500} lh={1.2}>{user?.name}</Text>
                      <Text size="xs" c="dimmed" lh={1.2} tt="capitalize">{user?.role}</Text>
                    </Stack>
                    <ChevronDown size={14} />
                  </Group>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{user?.email}</Menu.Label>
                <Menu.Item leftSection={<Settings size={15} />} onClick={() => navigate("/settings")}>Settings</Menu.Item>
                <Menu.Item leftSection={<LogOut size={15} />} color="red" onClick={logout}>Sign out</Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="sm">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={2}>{NAV.map(renderLink)}</Stack>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" mt="lg" mb={6} px={10} style={{ letterSpacing: 0.6 }}>
            System
          </Text>
          <Stack gap={2}>{NAV_SYSTEM.map(renderLink)}</Stack>
        </AppShell.Section>
        {counts.data && counts.data.pipeline.attention > 0 && (
          <AppShell.Section>
            <UnstyledButton
              w="100%"
              p="sm"
              style={{ borderRadius: 10, background: "var(--mantine-color-orange-light)" }}
              onClick={() => {
                navigate("/orders?tab=attention");
                close();
              }}
            >
              <Text size="sm" fw={600} c="orange">{counts.data.pipeline.attention} orders need attention</Text>
              <Text size="xs" c="dimmed">Flags, holds, failed fulfillment</Text>
            </UnstyledButton>
          </AppShell.Section>
        )}
      </AppShell.Navbar>
      <AppShell.Main>
        <Box maw={1480} mx="auto">
          {counts.data?.steadfastPause && (
            <Alert color="red" variant="filled" mb="md" title="Steadfast calls are paused">
              {counts.data.steadfastPause.message} Paused until {new Date(counts.data.steadfastPause.until).toLocaleTimeString()} so Steadfast doesn't lock the account.
              {counts.data.steadfastPause.reason === "auth_failed" && " Changing the keys in Settings → Connections resumes immediately."}
            </Alert>
          )}
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
