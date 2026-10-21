import { useState } from "react";
import { Alert, Box, Button, Center, Paper, PasswordInput, Stack, Text, TextInput, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Navigate, useLocation, useNavigate } from "react-router";
import { api, post } from "../api";
import { useAuth } from "../auth";
import { LoadingState } from "../components/ui";

export function LoginPage() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const setup = useQuery({ queryKey: ["setup-status"], queryFn: () => api<{ needsSetup: boolean }>("/auth/setup-status") });
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={(location.state as { from?: string })?.from ?? "/"} replace />;
  if (setup.isLoading) return <LoadingState />;
  const needsSetup = setup.data?.needsSetup;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(needsSetup ? "/auth/setup" : "/auth/login", form);
      await refresh();
      navigate((location.state as { from?: string })?.from ?? "/", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Center mih="100vh" p="md" style={{ background: "var(--app-bg)" }}>
      <Box w="100%" maw={400}>
        <Stack align="center" gap={6} mb="xl">
          <Box w={44} h={44} style={{ borderRadius: 12, background: "var(--mantine-color-brand-6)", display: "grid", placeItems: "center" }}>
            <svg width="22" height="22" viewBox="0 0 32 32"><path d="M5 27 16 4l11 23h-5.2L16 15.2 10.2 27z" fill="#fff" /></svg>
          </Box>
          <Title order={3} fw={600} mt="sm">{needsSetup ? "Set up ARVONO Fulfillment OS" : "Sign in to ARVONO"}</Title>
          <Text size="sm" c="dimmed" ta="center">
            {needsSetup ? "Create the owner account. You can invite staff afterwards." : "Fulfillment operations for Shopify and your couriers"}
          </Text>
        </Stack>
        <Paper withBorder p="xl" radius="lg" className="app-panel">
          <form onSubmit={submit}>
            <Stack>
              {error && <Alert color="red" variant="light">{error}</Alert>}
              {needsSetup && (
                <TextInput label="Your name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} />
              )}
              <TextInput label="Email" type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.currentTarget.value })} />
              <PasswordInput
                label="Password"
                required
                autoComplete={needsSetup ? "new-password" : "current-password"}
                description={needsSetup ? "At least 10 characters" : undefined}
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.currentTarget.value })}
              />
              <Button type="submit" loading={busy} fullWidth mt="xs">
                {needsSetup ? "Create owner account" : "Sign in"}
              </Button>
            </Stack>
          </form>
        </Paper>
      </Box>
    </Center>
  );
}
