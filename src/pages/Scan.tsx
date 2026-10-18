import { useCallback, useEffect, useRef, useState } from "react";
import { ActionIcon, Badge, Box, Button, Drawer, Group, NativeSelect, Paper, ScrollArea, Stack, Text, TextInput, Title, Tooltip } from "@mantine/core";
import { Camera, CameraOff, CheckCircle2, FlipHorizontal2, ListChecks, ScanLine, Wifi, WifiOff, XCircle, AlertTriangle, Keyboard } from "lucide-react";
import { BarcodeDetector as WasmBarcodeDetector, prepareZXingModule } from "barcode-detector/ponyfill";
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
const CAMERA_KEY = "arvono.scan.camera";
const MIRROR_KEY = "arvono.scan.mirror";

/** Camera reads per second. Each read looks at the area inside the guide box. */
const READS_PER_SECOND = 30;
/** Same label in front of the camera: counted once per this many ms. */
const SAME_CODE_MS = 2500;
/** Guide box (fraction of the frame) that is decoded. */
const ROI = { w: 0.8, h: 0.6 };
/** Decode at most this wide; plenty for a Code 128 label and keeps each read fast. */
const MAX_DECODE_WIDTH = 1280;
const FORMATS = ["code_128", "code_39", "code_93", "itf", "qr_code"] as const;

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
function tone(freq: number, ms: number, delay = 0, type: OscillatorType = "sine", volume = 0.4) {
  if (!audio) return;
  const t = audio.currentTime + delay / 1000;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  osc.type = type;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.008);
  gain.gain.setValueAtTime(volume, t + ms / 1000 - 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}
function feedback(kind: ScanKind) {
  if (kind === "sorted") {
    // Success: bright rising two-note chime.
    tone(1047, 80, 0, "sine", 0.45);
    tone(1568, 140, 80, "sine", 0.45);
    navigator.vibrate?.(60);
  } else if (kind === "duplicate") {
    // Already sorted: two flat mid beeps.
    tone(700, 90, 0, "square", 0.22);
    tone(700, 90, 160, "square", 0.22);
    navigator.vibrate?.([40, 60, 40]);
  } else {
    // Failure: low harsh buzzer, three pulses.
    tone(140, 200, 0, "sawtooth", 0.35);
    tone(140, 200, 260, "sawtooth", 0.35);
    tone(110, 320, 520, "sawtooth", 0.35);
    navigator.vibrate?.([300, 100, 300]);
  }
}

type Tone = "good" | "warn" | "bad" | "idle";
const toneOf = (kind: Result["kind"] | undefined): Tone => (!kind || kind === "pending" ? "idle" : kind === "sorted" ? "good" : kind === "duplicate" ? "warn" : "bad");
const PANEL_BG: Record<Tone, { strong: string; soft: string }> = {
  good: { strong: "#12a150", soft: "rgba(18,161,80,0.32)" },
  warn: { strong: "#e8a400", soft: "rgba(232,164,0,0.30)" },
  bad: { strong: "#d92d2d", soft: "rgba(217,45,45,0.34)" },
  idle: { strong: "rgba(255,255,255,0.06)", soft: "rgba(255,255,255,0.06)" },
};

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

function store(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode)
  }
}
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function loadPending(): Record<string, { code: string; batchId: string | null }> {
  try {
    return JSON.parse(read(PENDING_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePending(p: Record<string, { code: string; batchId: string | null }>) {
  store(PENDING_KEY, JSON.stringify(p));
}

type Detector = { detect(source: CanvasImageSource): Promise<{ rawValue: string }[]> };
/** Native detector where the browser has one (Chrome on macOS/Android) — fastest; WASM elsewhere (Safari/iOS). */
async function createDetector(): Promise<{ detector: Detector; engine: "native" | "wasm" }> {
  const Native = (globalThis as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
  if (Native) {
    try {
      const supported = await Native.getSupportedFormats();
      if (supported.includes("code_128")) return { detector: new Native({ formats: FORMATS.filter((f) => supported.includes(f)) }), engine: "native" };
    } catch {
      // fall back to WASM
    }
  }
  return { detector: new WasmBarcodeDetector({ formats: [...FORMATS] }), engine: "wasm" };
}

export default function Scan() {
  const navigate = useNavigate();
  const [batchId, setBatchId] = useState<string | null>(() => read(BATCH_KEY));
  const [connected, setConnected] = useState(false);
  const [camera, setCamera] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(() => read(CAMERA_KEY));
  const [mirror, setMirror] = useState<boolean | null>(() => (read(MIRROR_KEY) === null ? null : read(MIRROR_KEY) === "1"));
  const [autoMirror, setAutoMirror] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  const [rate, setRate] = useState<{ reads: number; engine: string } | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [flash, setFlash] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [manual, setManual] = useState("");
  const [pendingCount, setPendingCount] = useState(() => Object.keys(loadPending()).length);

  const wsRef = useRef<WebSocket | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastCode = useRef<{ code: string; at: number }>({ code: "", at: 0 });
  const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const manualRef = useRef<HTMLInputElement>(null);
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
    if (r.kind !== "pending") {
      feedback(r.kind as ScanKind);
      // Side panels light up strongly, then settle to a softer tint until the next scan.
      setFlash(true);
      clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(false), 1400);
    }
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
      // The camera sees the same label many times a second; count it once.
      if (lastCode.current.code === code && now - lastCode.current.at < SAME_CODE_MS) {
        lastCode.current.at = now; // still in front of the camera
        return;
      }
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
    setRate(null);
  }, []);

  const startCamera = useCallback(
    async (id: string | null = deviceId): Promise<void> => {
      unlockAudio();
      setCameraError(null);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(id ? { deviceId: { exact: id } } : { facingMode: { ideal: "environment" } }),
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 },
          },
        });
        streamRef.current = stream;
        const settings = stream.getVideoTracks()[0]?.getSettings();
        // Laptop/front cameras look like a mirror; back cameras don't.
        setAutoMirror(settings?.facingMode !== "environment");
        const video = videoRef.current!;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.muted = true;
        await video.play();
        if (video.videoWidth && video.videoHeight) setAspect(video.videoWidth / video.videoHeight);
        setCamera(true);
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        setDevices(list);
      } catch (err) {
        if (id && (err as Error).name === "OverconstrainedError") {
          // Saved camera unplugged; fall back to the default one.
          store(CAMERA_KEY, null);
          setDeviceId(null);
          return startCamera(null);
        }
        setCameraError((err as Error).message || "Camera not available. Allow camera access in browser settings.");
      }
    },
    [deviceId],
  );

  useEffect(() => {
    if (!camera) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    let reads = 0;
    let engine = "…";
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const meter = setInterval(() => {
      setRate({ reads, engine });
      reads = 0;
    }, 1000);
    void createDetector().then(({ detector, engine: e }) => {
      engine = e;
      const interval = 1000 / READS_PER_SECOND;
      const tick = async () => {
        if (!alive) return;
        const started = performance.now();
        const video = videoRef.current;
        if (video && video.readyState >= 2 && video.videoWidth) {
          // Decode only the guide box, scaled down if the camera is very high resolution.
          const sw = Math.round(video.videoWidth * ROI.w);
          const sh = Math.round(video.videoHeight * ROI.h);
          const sx = Math.round((video.videoWidth - sw) / 2);
          const sy = Math.round((video.videoHeight - sh) / 2);
          const scale = Math.min(1, MAX_DECODE_WIDTH / sw);
          const dw = Math.round(sw * scale);
          const dh = Math.round(sh * scale);
          if (canvas.width !== dw || canvas.height !== dh) {
            canvas.width = dw;
            canvas.height = dh;
          }
          ctx.drawImage(video, sx, sy, sw, sh, 0, 0, dw, dh);
          try {
            const codes = await detector.detect(canvas);
            reads++;
            for (const c of codes) if (c.rawValue) submit(c.rawValue);
          } catch {
            // frame not ready; try again next tick
          }
        }
        timer = setTimeout(tick, Math.max(0, interval - (performance.now() - started)));
      };
      void tick();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(meter);
    };
  }, [camera, submit]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // USB/Bluetooth scanners type the code and press Enter: keep the input focused while scanning.
  useEffect(() => {
    if (!batchId) return;
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) manualRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [batchId]);

  const startSession = async () => {
    unlockAudio();
    const { id } = await post<{ id: string }>("/v1/dispatch/batches", {});
    store(BATCH_KEY, id);
    setBatchId(id);
    setResults([]);
    setTimeout(refreshSummary, 50);
    void startCamera();
  };

  const finishSession = async () => {
    if (batchId) await post(`/v1/dispatch/batches/${batchId}/close`, {}).catch(() => {});
    store(BATCH_KEY, null);
    stopCamera();
    setListOpen(true);
    setBatchId(null);
  };

  const last = results.find((r) => r.kind !== "pending") ?? results[0];
  const style = last ? KIND_STYLE[last.kind] : null;
  const panelTone = toneOf(last?.kind);
  const panelBg = flash ? PANEL_BG[panelTone].strong : PANEL_BG[panelTone].soft;
  const sortedNow = summary?.scanned.length ?? results.filter((r) => r.kind === "sorted").length;
  const mirrored = mirror ?? autoMirror;
  const sending = results.filter((r) => r.kind === "pending").length;
  const inputStyles = { input: { background: "rgba(255,255,255,0.08)", color: "#fff", borderColor: "rgba(255,255,255,0.15)" } };

  return (
    <Box style={{ height: "100dvh", background: "var(--mantine-color-dark-8)", color: "#fff", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Group justify="space-between" px="md" py="sm" style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }} wrap="nowrap">
        <Group gap={8} wrap="nowrap">
          <ScanLine size={20} />
          <Title order={4} c="white">Scan & sort</Title>
        </Group>
        <Group gap={6} wrap="nowrap">
          {rate && (
            <Tooltip label={rate.engine === "native" ? "Browser's built-in barcode reader" : "Built-in WASM barcode reader"}>
              <Badge color="gray" variant="light">{rate.reads} reads/s</Badge>
            </Tooltip>
          )}
          {pendingCount > 0 && <Badge color="yellow">{pendingCount} queued</Badge>}
          <Badge color={connected ? "teal" : "red"} leftSection={connected ? <Wifi size={11} /> : <WifiOff size={11} />}>{connected ? "Live" : "Offline"}</Badge>
          <Button size="compact-xs" variant="outline" color="gray.4" c="gray.3" onClick={() => navigate("/dispatch")}>Exit</Button>
        </Group>
      </Group>

      <div className="scan-grid">
        {/* Left: result of the last scan */}
        <div className="scan-side scan-left" data-flash={flash} style={{ background: panelBg }}>
          {!last || !style ? (
            <Stack gap={6} justify="center" style={{ flex: 1 }}>
              <Text fw={700} fz="lg">Ready</Text>
              <Text size="sm" c="gray.4">Hold the label's barcode inside the box. Both sides turn green when the parcel is sorted and red when something is wrong.</Text>
            </Stack>
          ) : (
            <Stack gap="sm" style={{ flex: 1 }}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Text fw={900} fz={{ base: 26, md: 32 }} lh={1.05} c="white">{style.label}</Text>
                {last.kind === "sorted" ? <CheckCircle2 size={40} /> : last.kind === "duplicate" ? <AlertTriangle size={40} /> : last.kind === "pending" ? null : <XCircle size={40} />}
              </Group>
              <Text size="md" c="white" opacity={0.95}>{last.message}</Text>
              {last.order ? (
                <Box mt="xs">
                  <Text fw={800} fz={{ base: 24, md: 30 }} c="white" lh={1.1}>{last.order.name}</Text>
                  <Text fw={700} fz="xl" c="white">{money(last.order.cod)}</Text>
                  <Text size="md" c="white" opacity={0.95} mt={4}>{last.order.customer}</Text>
                  <Text size="sm" c="white" opacity={0.85}>{last.order.city ?? ""} · {last.order.items} item(s)</Text>
                  <Text size="xs" c="white" opacity={0.8} className="mono" mt={6}>CID {last.order.consignmentId ?? "—"} · {last.order.trackingCode ?? ""}</Text>
                </Box>
              ) : (
                <Text size="sm" c="white" opacity={0.85} className="mono">Code {last.code}</Text>
              )}
              {sending > 0 && <Text size="xs" c="white" opacity={0.7} mt="auto">Sending {sending}…</Text>}
            </Stack>
          )}
        </div>

        {/* Middle: camera */}
        <div className="scan-camera" style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
          <Box style={{ position: "relative", borderRadius: 18, overflow: "hidden", background: "#000", width: camera ? `min(100%, calc((100dvh - 200px) * ${aspect}))` : "100%", margin: "0 auto", aspectRatio: camera ? String(aspect) : undefined, minHeight: camera ? undefined : 220 }}>
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: "100%", height: "100%", objectFit: "contain", display: camera ? "block" : "none", transform: mirrored ? "scaleX(-1)" : undefined }}
            />
            {camera && (
              <Box
                style={{
                  position: "absolute",
                  left: `${((1 - ROI.w) / 2) * 100}%`,
                  top: `${((1 - ROI.h) / 2) * 100}%`,
                  width: `${ROI.w * 100}%`,
                  height: `${ROI.h * 100}%`,
                  border: `3px solid ${panelTone === "idle" ? "rgba(80,255,180,0.85)" : PANEL_BG[panelTone].strong}`,
                  borderRadius: 14,
                  boxShadow: "0 0 0 2000px rgba(0,0,0,0.28)",
                  transition: "border-color 150ms",
                  pointerEvents: "none",
                }}
              />
            )}
            {!camera && (
              <Stack align="center" justify="center" p="lg" gap="sm" style={{ minHeight: 220 }}>
                {!batchId ? (
                  <Button size="lg" leftSection={<ScanLine size={20} />} onClick={startSession}>Start scanning</Button>
                ) : (
                  <Button size="lg" leftSection={<Camera size={20} />} onClick={() => startCamera()}>Open camera</Button>
                )}
                {cameraError && <Text size="sm" c="red.4" ta="center">{cameraError}</Text>}
              </Stack>
            )}
            {camera && (
              <Group gap={6} style={{ position: "absolute", top: 10, right: 10 }}>
                <Tooltip label="Flip preview">
                  <ActionIcon
                    size="lg"
                    radius="xl"
                    variant="filled"
                    color="dark"
                    onClick={() => {
                      setMirror(!mirrored);
                      store(MIRROR_KEY, mirrored ? "0" : "1");
                    }}
                    aria-label="Flip preview"
                  >
                    <FlipHorizontal2 size={18} />
                  </ActionIcon>
                </Tooltip>
                <ActionIcon size="lg" radius="xl" variant="filled" color="dark" onClick={stopCamera} aria-label="Stop camera">
                  <CameraOff size={18} />
                </ActionIcon>
              </Group>
            )}
          </Box>

          <Group gap="xs" wrap="nowrap" align="flex-end">
            <form
              style={{ flex: 1 }}
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
                placeholder="Type consignment ID or use a scanner gun"
                leftSection={<Keyboard size={16} />}
                inputMode="numeric"
                value={manual}
                onChange={(e) => setManual(e.currentTarget.value)}
                styles={inputStyles}
              />
            </form>
            {devices.length > 1 && (
              <NativeSelect
                aria-label="Camera"
                w={190}
                value={deviceId ?? streamRef.current?.getVideoTracks()[0]?.getSettings().deviceId ?? ""}
                data={devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Camera ${i + 1}` }))}
                onChange={(e) => {
                  const id = e.currentTarget.value;
                  setDeviceId(id);
                  store(CAMERA_KEY, id);
                  setMirror(null);
                  store(MIRROR_KEY, null);
                  void startCamera(id);
                }}
                styles={inputStyles}
              />
            )}
          </Group>
        </div>

        {/* Right: session status */}
        <div className="scan-side scan-right" data-flash={flash} style={{ background: panelBg }}>
          <Group grow gap="xs">
            <Paper p="xs" radius="md" bg="rgba(0,0,0,0.25)">
              <Text size="xs" c="gray.3">Sorted this session</Text>
              <Text fz={34} fw={800} c="white" lh={1.1}>{sortedNow}</Text>
            </Paper>
            <Paper p="xs" radius="md" bg="rgba(0,0,0,0.25)" onClick={() => { refreshSummary(); setListOpen(true); }} style={{ cursor: "pointer" }}>
              <Text size="xs" c="gray.3">Still to sort</Text>
              <Text fz={34} fw={800} c={summary?.totals.toSort ? "yellow.3" : "white"} lh={1.1}>{summary?.totals.toSort ?? "…"}</Text>
            </Paper>
          </Group>
          {summary && summary.totals.sortedCancelled > 0 && (
            <Paper mt="xs" p="xs" radius="md" bg="red.9">
              <Text size="sm" fw={600}>⚠ {summary.totals.sortedCancelled} sorted parcel(s) were cancelled in Shopify — pull them out.</Text>
            </Paper>
          )}

          <Text size="xs" fw={600} c="gray.3" mt="md" mb={6} tt="uppercase" style={{ letterSpacing: 0.5 }}>Recent scans</Text>
          <ScrollArea style={{ flex: 1, minHeight: 120 }} type="auto">
            <Stack gap={6}>
              {results.slice(0, 40).map((r) => (
                <Group key={r.id} justify="space-between" wrap="nowrap" px="sm" py={6} style={{ borderRadius: 10, background: "rgba(0,0,0,0.25)" }}>
                  <Text size="sm" lineClamp={1}>{r.order?.name ?? r.code} <Text span c="gray.4" size="xs">{r.order?.customer ?? ""}</Text></Text>
                  <Badge size="sm" color={KIND_STYLE[r.kind].color}>{KIND_STYLE[r.kind].label}</Badge>
                </Group>
              ))}
              {!results.length && <Text size="sm" c="gray.4">No scans yet.</Text>}
            </Stack>
          </ScrollArea>

          {batchId && (
            <Group grow pt="sm" gap="xs">
              <Button variant="default" leftSection={<ListChecks size={16} />} onClick={() => { refreshSummary(); setListOpen(true); }}>Remaining</Button>
              <Button color="teal" onClick={finishSession}>Finish</Button>
            </Group>
          )}
        </div>
      </div>

      <Drawer opened={listOpen} onClose={() => setListOpen(false)} position="right" size="md" title={<Text fw={600}>Session summary</Text>}>
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
