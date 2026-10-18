import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Badge, Box, Button, Drawer, Group, Paper, ScrollArea, Stack, Text, TextInput, Title } from "@mantine/core";
import { Camera, CameraOff, CheckCircle2, ListChecks, ScanLine, Wifi, WifiOff, XCircle, AlertTriangle, Keyboard } from "lucide-react";
import { BarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { useNavigate } from "react-router";
import { api, post } from "../api";
import { money } from "../format";

// Load the barcode decoder from our own origin (no CDN dependency on the packing floor).
prepareZXingModule({ overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path) } });

type ScanKind = "sorted" | "duplicate" | "cancelled" | "already_dispatched" | "not_booked" | "old_label" | "unknown";
type Result = {
  id: string;
  code: string;
  kind: ScanKind | "pending";
  ok: boolean;
  message: string;
  order?: { id: number; name: string; customer: string | null; phone: string | null; city: string | null; cod: number; items: number; consignmentId: string | null; trackingCode: string | null; sortedBy?: string | null };
  at: number;
};
type Summary = {
  batch: { id: string; name: string; scannedCount: number } | null;
  scanned: { id: number; name: string; customer: string | null; city: string | null; cid: string | null }[];
  remaining: { id: number; name: string; customer: string | null; city: string | null; cid: string | null }[];
  totals: { toSort: number; sortedWaiting: number; sortedCancelled: number };
};

const PENDING_KEY = "arvono.scan.pending";
const BATCH_KEY = "arvono.scan.batch";

// ---- Sound & haptics ---------------------------------------------------------
let audio: AudioContext | null = null;
function unlockAudio() {
  try {
    audio ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (audio.state === "suspended") void audio.resume();
  } catch {
    // no audio available
  }
}
function tone(freq: number, ms: number, delay = 0) {
  if (!audio) return;
  const t = audio.currentTime + delay / 1000;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  osc.type = "square";
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}
function feedback(kind: ScanKind) {
  if (kind === "sorted") {
    tone(1760, 120);
    navigator.vibrate?.(60);
  } else if (kind === "duplicate") {
    tone(1200, 80);
    tone(1200, 80, 140);
    navigator.vibrate?.([40, 60, 40]);
  } else {
    tone(220, 450);
    navigator.vibrate?.([300, 100, 300]);
  }
}

const KIND_STYLE: Record<string, { color: string; label: string }> = {
  sorted: { color: "teal", label: "SORTED" },
  duplicate: { color: "yellow", label: "ALREADY SORTED" },
  cancelled: { color: "red", label: "STOP — CANCELLED" },
  already_dispatched: { color: "orange", label: "ALREADY PICKED UP" },
  not_booked: { color: "red", label: "NOT BOOKED" },
  old_label: { color: "red", label: "OLD LABEL" },
  unknown: { color: "red", label: "NOT FOUND" },
  pending: { color: "gray", label: "SENDING…" },
};

function loadPending(): Record<string, { code: string; batchId: string | null }> {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePending(p: Record<string, { code: string; batchId: string | null }>) {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(p));
  } catch {
    // storage unavailable (private mode); scans still go out live
  }
}

export default function Scan() {
  const navigate = useNavigate();
  const [batchId, setBatchId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BATCH_KEY);
    } catch {
      return null;
    }
  });
  const [connected, setConnected] = useState(false);
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [pendingCount, setPendingCount] = useState(() => Object.keys(loadPending()).length);

  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastCode = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const batchRef = useRef(batchId);
  batchRef.current = batchId;

  const refreshSummary = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "summary", batchId: batchRef.current }));
    else api<Summary>(`/v1/dispatch/batches/${batchRef.current ?? "none"}`).then(setSummary).catch(() => {});
  }, []);

  const applyResult = useCallback((r: Omit<Result, "at">) => {
    const pending = loadPending();
    delete pending[r.id];
    savePending(pending);
    setPendingCount(Object.keys(pending).length);
    setResults((prev) => [{ ...r, at: Date.now() }, ...prev.filter((x) => x.id !== r.id)].slice(0, 60));
    if (r.kind !== "pending") feedback(r.kind as ScanKind);
  }, []);

  // ---- Live connection with automatic reconnect & resend --------------------
  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let ping: ReturnType<typeof setInterval>;
    const connect = () => {
      const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/dispatch/scan/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        for (const [id, p] of Object.entries(loadPending())) ws.send(JSON.stringify({ t: "scan", id, code: p.code, batchId: p.batchId }));
        ws.send(JSON.stringify({ t: "summary", batchId: batchRef.current }));
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ t: "ping" })), 25_000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === "result") {
          applyResult(msg);
          ws.send(JSON.stringify({ t: "summary", batchId: batchRef.current }));
        } else if (msg.t === "summary") setSummary(msg);
      };
      ws.onclose = () => {
        clearInterval(ping);
        setConnected(false);
        if (!stopped) setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
      };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => {
      stopped = true;
      clearInterval(ping);
      wsRef.current?.close();
    };
  }, [applyResult]);

  const submit = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code) return;
      const now = Date.now();
      // The camera sees the same label many times a second; one scan per label per 3s.
      if (lastCode.current.code === code && now - lastCode.current.at < 3000) return;
      lastCode.current = { code, at: now };
      const id = crypto.randomUUID?.() ?? `${now}-${Math.random()}`;
      const pending = loadPending();
      pending[id] = { code, batchId: batchRef.current };
      savePending(pending);
      setPendingCount(Object.keys(pending).length);
      setResults((prev) => [{ id, code, kind: "pending" as const, ok: false, message: "Sending…", at: now }, ...prev].slice(0, 60));
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "scan", id, code, batchId: batchRef.current }));
      } else {
        // Fallback over HTTP; if that fails too, the scan stays queued and is resent on reconnect.
        post<Omit<Result, "id" | "code" | "at">>("/v1/dispatch/scan", { code, batchId: batchRef.current })
          .then((r) => applyResult({ ...r, id, code }))
          .catch(() => {});
      }
    },
    [applyResult],
  );

  // ---- Camera ---------------------------------------------------------------
  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCamera(false);
  }, []);

  const startCamera = useCallback(async () => {
    unlockAudio();
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      video.muted = true;
      await video.play();
      setCamera(true);
    } catch (err) {
      setCameraError((err as Error).message || "Camera not available. Allow camera access in browser settings.");
    }
  }, []);

  useEffect(() => {
    if (!camera) return;
    const detector = new BarcodeDetector({ formats: ["code_128", "code_39", "qr_code", "ean_13", "itf", "codabar", "code_93"] });
    let alive = true;
    let busy = false;
    const tick = async () => {
      if (!alive) return;
      const video = videoRef.current;
      if (!busy && video && video.readyState >= 2) {
        busy = true;
        try {
          const codes = await detector.detect(video);
          for (const c of codes) if (c.rawValue) submit(c.rawValue);
        } catch {
          // frame not ready; try again next tick
        }
        busy = false;
      }
      setTimeout(tick, 120);
    };
    tick();
    return () => {
      alive = false;
    };
  }, [camera, submit]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // Hardware scanners (Bluetooth/USB) type the code and press Enter.
  const manualRef = useRef<HTMLInputElement>(null);

  const startSession = async () => {
    unlockAudio();
    const { id } = await post<{ id: string }>("/v1/dispatch/batches", {});
    try {
      localStorage.setItem(BATCH_KEY, id);
    } catch {
      // ignore
    }
    setBatchId(id);
    setResults([]);
    setTimeout(refreshSummary, 50);
    void startCamera();
  };

  const finishSession = async () => {
    if (batchId) await post(`/v1/dispatch/batches/${batchId}/close`, {}).catch(() => {});
    try {
      localStorage.removeItem(BATCH_KEY);
    } catch {
      // ignore
    }
    stopCamera();
    setListOpen(true);
    setBatchId(null);
  };

  const last = results[0];
  const style = last ? KIND_STYLE[last.kind] : null;
  const sortedNow = summary?.scanned.length ?? results.filter((r) => r.kind === "sorted").length;

  return (
    <Box style={{ minHeight: "100dvh", background: "var(--mantine-color-dark-8)", color: "#fff", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Group justify="space-between" px="md" py="sm" style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
        <Group gap={8}>
          <ScanLine size={20} />
          <Title order={4} c="white">Scan & sort</Title>
        </Group>
        <Group gap={6}>
          {pendingCount > 0 && <Badge color="yellow">{pendingCount} queued</Badge>}
          <Badge color={connected ? "teal" : "red"} leftSection={connected ? <Wifi size={11} /> : <WifiOff size={11} />}>{connected ? "Live" : "Offline"}</Badge>
          <Button size="compact-xs" variant="outline" color="gray.4" c="gray.3" onClick={() => navigate("/dispatch")}>Exit</Button>
        </Group>
      </Group>

      {/* Counters */}
      <Group grow px="md" py="xs" gap="xs">
        <Paper p="xs" radius="md" bg="rgba(255,255,255,0.06)">
          <Text size="xs" c="gray.5">Sorted this session</Text>
          <Text fz={28} fw={700} c="teal.4" lh={1.1}>{sortedNow}</Text>
        </Paper>
        <Paper p="xs" radius="md" bg="rgba(255,255,255,0.06)" onClick={() => setListOpen(true)} style={{ cursor: "pointer" }}>
          <Text size="xs" c="gray.5">Still to sort</Text>
          <Text fz={28} fw={700} c={summary?.totals.toSort ? "yellow.4" : "teal.4"} lh={1.1}>{summary?.totals.toSort ?? "…"}</Text>
        </Paper>
      </Group>
      {summary && summary.totals.sortedCancelled > 0 && (
        <Paper mx="md" mb="xs" p="xs" radius="md" bg="red.9">
          <Text size="sm" fw={600}>⚠ {summary.totals.sortedCancelled} sorted parcel(s) were cancelled in Shopify — pull them out.</Text>
        </Paper>
      )}

      {/* Camera */}
      <Box mx="md" style={{ position: "relative", borderRadius: 16, overflow: "hidden", background: "#000", aspectRatio: camera ? "4 / 3" : undefined, minHeight: camera ? undefined : 160 }}>
        <video ref={videoRef} playsInline muted style={{ width: "100%", height: "100%", objectFit: "cover", display: camera ? "block" : "none" }} />
        {camera && <Box style={{ position: "absolute", left: "8%", right: "8%", top: "42%", height: 2, background: "rgba(80,255,180,0.8)", boxShadow: "0 0 12px rgba(80,255,180,0.9)" }} />}
        {!camera && (
          <Stack align="center" justify="center" p="lg" gap="sm" style={{ minHeight: 160 }}>
            {!batchId ? (
              <Button size="lg" leftSection={<ScanLine size={20} />} onClick={startSession}>Start scanning</Button>
            ) : (
              <Button size="lg" leftSection={<Camera size={20} />} onClick={startCamera}>Open camera</Button>
            )}
            {cameraError && <Text size="sm" c="red.4" ta="center">{cameraError}</Text>}
          </Stack>
        )}
        {camera && (
          <ActionIcon size="lg" radius="xl" variant="filled" color="dark" style={{ position: "absolute", top: 10, right: 10 }} onClick={stopCamera} aria-label="Stop camera">
            <CameraOff size={18} />
          </ActionIcon>
        )}
      </Box>

      {/* Last result */}
      {last && style && (
        <Paper mx="md" mt="sm" p="md" radius="lg" bg={`${style.color}.9`} style={{ transition: "background 120ms" }}>
          <Group justify="space-between" align="flex-start" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Text fw={800} fz="lg" c="white">{style.label}</Text>
              <Text size="sm" c="white" opacity={0.9}>{last.message}</Text>
            </div>
            {last.kind === "sorted" ? <CheckCircle2 size={34} /> : last.kind === "duplicate" ? <AlertTriangle size={34} /> : last.kind === "pending" ? null : <XCircle size={34} />}
          </Group>
          {last.order && (
            <Box mt="xs">
              <Text fw={700} fz="xl" c="white">{last.order.name} · {money(last.order.cod)}</Text>
              <Text size="sm" c="white" opacity={0.9}>{last.order.customer} · {last.order.city ?? ""} · {last.order.items} item(s)</Text>
              <Text size="xs" c="white" opacity={0.8} className="mono">CID {last.order.consignmentId ?? "—"} · {last.order.trackingCode ?? ""}</Text>
            </Box>
          )}
        </Paper>
      )}

      {/* Manual / hardware scanner input */}
      <Box px="md" mt="sm">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            unlockAudio();
            submit(manual);
            setManual("");
            manualRef.current?.focus();
          }}
        >
          <TextInput
            ref={manualRef}
            placeholder="Type consignment ID or use a scanner"
            leftSection={<Keyboard size={16} />}
            inputMode="numeric"
            value={manual}
            onChange={(e) => setManual(e.currentTarget.value)}
            styles={{ input: { background: "rgba(255,255,255,0.08)", color: "#fff", borderColor: "rgba(255,255,255,0.15)" } }}
          />
        </form>
      </Box>

      {/* Recent scans */}
      <ScrollArea style={{ flex: 1 }} px="md" mt="sm">
        <Stack gap={6} pb="md">
          {results.slice(1, 30).map((r) => (
            <Group key={r.id} justify="space-between" wrap="nowrap" px="sm" py={6} style={{ borderRadius: 10, background: "rgba(255,255,255,0.05)" }}>
              <Text size="sm" lineClamp={1}>{r.order?.name ?? r.code} <Text span c="gray.5" size="xs">{r.order?.customer ?? ""}</Text></Text>
              <Badge size="sm" color={KIND_STYLE[r.kind].color}>{KIND_STYLE[r.kind].label}</Badge>
            </Group>
          ))}
        </Stack>
      </ScrollArea>

      {batchId && (
        <Group grow p="md" gap="xs" style={{ borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <Button variant="default" leftSection={<ListChecks size={16} />} onClick={() => { refreshSummary(); setListOpen(true); }}>Remaining</Button>
          <Button color="teal" onClick={finishSession}>Finish</Button>
        </Group>
      )}

      <Drawer opened={listOpen} onClose={() => setListOpen(false)} position="bottom" size="85%" title={<Text fw={600}>Session summary</Text>}>
        <Stack>
          <Group grow>
            <Paper withBorder p="sm"><Text size="xs" c="dimmed">Sorted this session</Text><Text fw={700} fz="xl">{summary?.scanned.length ?? 0}</Text></Paper>
            <Paper withBorder p="sm"><Text size="xs" c="dimmed">Still to sort</Text><Text fw={700} fz="xl" c={summary?.totals.toSort ? "orange" : "teal"}>{summary?.totals.toSort ?? 0}</Text></Paper>
          </Group>
          <Text fw={600} size="sm">Not scanned yet ({summary?.remaining.length ?? 0})</Text>
          {summary?.remaining.length ? (
            summary.remaining.map((o) => (
              <Group key={o.id} justify="space-between" wrap="nowrap">
                <Text size="sm">{o.name} · {o.customer}</Text>
                <Text size="xs" c="dimmed" className="mono">{o.cid}</Text>
              </Group>
            ))
          ) : (
            <Text size="sm" c="teal">Everything booked has been sorted ✓</Text>
          )}
        </Stack>
      </Drawer>
    </Box>
  );
}
