import init, { MicNode } from "./wasm/iroh_mic.js";

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 480; // 10 ms at 48 kHz
const MAX_QUEUED_FRAMES = 20; // ~200 ms of backlog before we drop oldest
const ENDPOINT_ID_RE = /^[0-9a-fA-F]{64}$/;
const SECRET_STORAGE_KEY = "iroh-mic:secret";
const PEERS_STORAGE_KEY = "iroh-mic:peers";
const RECONNECT_BASE_MS = 1500;
const RECONNECT_MAX_MS = 15000;

const telemetry = {
  state: "booting",
  peers: 0,
  playback: false,
  framesSent: 0,
  framesReceived: 0,
  bytesSent: 0,
  bytesReceived: 0,
  inputRms: 0,
  outputRms: 0,
  inputDb: -Infinity,
  outputDb: -Infinity,
};

const peers = new Map();
let node = null;
let ctx = null;
let captureNode = null;
let playbackNode = null;
let activePeer = null;
const sendQueue = [];
let pumping = false;

// Peers the user asked to be connected to. Kept per tab (sessionStorage) so a
// mobile reload keeps the same endpoint identity and reconnects automatically.
const desiredPeers = new Set(loadDesiredPeers());
const reconnectTimers = new Map();
const reconnectAttempts = new Map();
let wakeLock = null;
let playbackPromise = null;

function hexToBytes(hex) {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function loadDesiredPeers() {
  try {
    const list = JSON.parse(sessionStorage.getItem(PEERS_STORAGE_KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((id) => ENDPOINT_ID_RE.test(id)) : [];
  } catch {
    return [];
  }
}

function saveDesiredPeers() {
  try {
    sessionStorage.setItem(PEERS_STORAGE_KEY, JSON.stringify([...desiredPeers]));
  } catch {
    /* storage may be unavailable */
  }
}

function markDesired(peerId) {
  desiredPeers.add(peerId);
  reconnectAttempts.delete(peerId);
  saveDesiredPeers();
}

function unmarkDesired(peerId) {
  desiredPeers.delete(peerId);
  const timer = reconnectTimers.get(peerId);
  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(peerId);
  }
  reconnectAttempts.delete(peerId);
  saveDesiredPeers();
}

function scheduleReconnect(peerId, immediate = false) {
  if (!desiredPeers.has(peerId) || peers.has(peerId) || reconnectTimers.has(peerId)) return;
  const attempts = reconnectAttempts.get(peerId) ?? 0;
  const delay = immediate ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
  const timer = setTimeout(() => {
    reconnectTimers.delete(peerId);
    reconnectPeer(peerId);
  }, delay);
  reconnectTimers.set(peerId, timer);
}

async function reconnectPeer(peerId) {
  if (!desiredPeers.has(peerId) || peers.has(peerId)) return;
  if (document.hidden) return; // handleResume retries when visible again
  reconnectAttempts.set(peerId, (reconnectAttempts.get(peerId) ?? 0) + 1);
  try {
    await node.connect(peerId);
    reconnectAttempts.delete(peerId);
    log(`reconnected to ${peerId.slice(0, 8)}…`, "ok");
  } catch (err) {
    log(`reconnect to ${peerId.slice(0, 8)}… failed: ${err}`);
    scheduleReconnect(peerId);
  }
}

async function disconnectAll() {
  for (const id of [...desiredPeers]) {
    unmarkDesired(id);
    try {
      await node.disconnect(id);
    } catch {
      /* already gone */
    }
  }
  log("disconnected; auto-reconnect stopped", "ok");
}

function resumeAudio() {
  if (ctx && ctx.state === "suspended") ctx.resume().catch(() => {});
}

async function requestWakeLock() {
  if (!ctx || !("wakeLock" in navigator) || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {
    wakeLock = null;
  }
}

function handleResume() {
  resumeAudio();
  requestWakeLock();
  for (const peerId of desiredPeers) {
    if (!peers.has(peerId)) scheduleReconnect(peerId, true);
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) handleResume();
});
window.addEventListener("focus", handleResume);
window.addEventListener("online", handleResume);
window.addEventListener("pageshow", (event) => {
  if (event.persisted) handleResume();
});

// Browsers only allow audio after a user gesture; use any tap to unlock it.
window.addEventListener(
  "pointerdown",
  () => {
    ensurePlayback().catch(() => {});
  },
  { passive: true },
);

const $ = (selector) => document.querySelector(selector);

function log(message, className) {
  const el = document.createElement("div");
  if (className) el.className = className;
  const time = new Date().toISOString().substring(11, 19);
  el.textContent = `${time}  ${message}`;
  const container = $("#log");
  container.prepend(el);
  while (container.childElementCount > 200) container.lastElementChild.remove();
}

function dbFromRms(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function floatToPcm16(float32) {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    const sample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, sample, true);
  }
  return bytes;
}

function onCaptureFrame(float32) {
  let acc = 0;
  for (let i = 0; i < float32.length; i++) acc += float32[i] * float32[i];
  telemetry.inputRms = Math.sqrt(acc / float32.length);

  if (!activePeer) return;
  if (sendQueue.length >= MAX_QUEUED_FRAMES) sendQueue.shift();
  sendQueue.push(floatToPcm16(float32));
  pumpSender();
}

async function pumpSender() {
  if (pumping) return;
  pumping = true;
  try {
    while (sendQueue.length > 0) {
      const frame = sendQueue.shift();
      if (!activePeer) continue;
      try {
        await node.send_audio(activePeer, frame);
        telemetry.framesSent += 1;
        telemetry.bytesSent += frame.byteLength;
      } catch (err) {
        log(`send failed: ${err}`, "error");
        sendQueue.length = 0;
      }
    }
  } finally {
    pumping = false;
  }
}

async function ensurePlayback() {
  if (!playbackPromise) {
    playbackPromise = setupPlayback().catch((err) => {
      playbackPromise = null;
      throw err;
    });
  }
  return playbackPromise;
}

async function setupPlayback() {
  if (!ctx) {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await ctx.audioWorklet.addModule("./playback-worklet.js");
  }
  if (!playbackNode) {
    playbackNode = new AudioWorkletNode(ctx, "playback", { outputChannelCount: [1] });
    playbackNode.port.onmessage = (event) => {
      telemetry.outputRms = event.data.rms;
    };
    playbackNode.connect(ctx.destination);
  }
  if (ctx.state === "suspended") {
    await ctx.resume().catch(() => {});
  }
  telemetry.playback = ctx.state === "running";
  requestWakeLock();
  updateAudioAlert();
  return telemetry.playback;
}

async function startListening() {
  const running = await ensurePlayback();
  if (running && !captureNode) telemetry.state = "listening";
  log(running ? "playback enabled" : "playback still blocked; tap the page", running ? "ok" : "error");
  updateAudioAlert();
}

async function startCapture(mode) {
  await ensurePlayback();
  if (captureNode) return;
  await ctx.audioWorklet.addModule("./capture-worklet.js");
  captureNode = new AudioWorkletNode(ctx, "capture");
  captureNode.port.onmessage = (event) => onCaptureFrame(event.data);

  // Keep the capture graph pulling without echoing microphone audio locally.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  captureNode.connect(mute).connect(ctx.destination);

  if (mode === "tone") {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = 440;
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    osc.connect(gain).connect(captureNode);
    osc.start();
    telemetry.state = "capturing (test tone)";
    log("capturing generated 440 Hz test tone");
  } else {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    ctx.createMediaStreamSource(stream).connect(captureNode);
    telemetry.state = "capturing (microphone)";
    log("capturing microphone input");
  }
  updateAudioAlert();
}

function updateAudioAlert() {
  const el = $("#audio-alert");
  if (!el) return;
  const running = !!ctx && ctx.state === "running";
  if (running) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  if (telemetry.framesReceived > 0) {
    el.innerHTML =
      "<b>Playing muted:</b> audio is arriving but this device has not enabled playback. " +
      "Tap anywhere on the page (or press listen) to unmute. On iPhone, also check the " +
      "side mute switch and the volume.";
  } else {
    el.innerHTML =
      "Audio plays only after a tap on this device. Press <b>listen</b> to hear the other side " +
      "(or start microphone/test tone to send as well).";
  }
}

const RELAY_HOSTS = [
  "use1-1.relay.n0.iroh.link",
  "usw1-1.relay.n0.iroh.link",
  "euc1-1.relay.n0.iroh.link",
  "aps1-1.relay.n0.iroh.link",
];

// Non-iroh control endpoints: if these also fail, the device/network blocks
// WebSockets; if they work, the problem is specific to the relay handshake.
const CONTROL_WS = ["wss://echo.websocket.org", "wss://ws.postman-echo.com/raw"];

function httpProbe(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
    fetch(url, { signal: controller.signal, cache: "no-store", mode: "cors" })
      .then((response) => {
        clearTimeout(timer);
        resolve(`HTTP ${response.status}`);
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve(String(err));
      });
  });
}

// Reachability-only check for endpoints without CORS headers.
function reachableProbe(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
    fetch(url, { signal: controller.signal, cache: "no-store", mode: "no-cors" })
      .then(() => {
        clearTimeout(timer);
        resolve("reachable (opaque)");
      })
      .catch((err) => {
        clearTimeout(timer);
        resolve(String(err));
      });
  });
}

function wsProbe(url, protocols, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let socket = null;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    try {
      socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    } catch (err) {
      finish(`throw: ${err}`);
      return;
    }
    socket.binaryType = "arraybuffer";
    socket.onopen = () => finish(`open (${socket.protocol || "no subprotocol"})`);
    // Keep the last close code/reason: Safari often only reports via onclose.
    socket.onerror = () => {};
    socket.onclose = (event) =>
      finish(`closed ${event.code}${event.reason ? ` ${event.reason}` : ""}`);
  });
}

async function runDiagnostics() {
  const out = $("#diagnostics");
  if (out) out.textContent = "running…";
  const lines = [
    `time: ${new Date().toISOString()}`,
    `user agent: ${navigator.userAgent}`,
    `secure context: ${window.isSecureContext}`,
    `wasm: ${typeof WebAssembly === "object"}`,
    `websocket: ${typeof WebSocket !== "undefined"}`,
    `online: ${navigator.onLine}`,
    `endpoint id: ${node ? node.endpoint_id() : "(not ready)"}`,
    `known peers: ${[...peers.keys()].join(", ") || "(none)"}`,
    "",
    "relay probes:",
  ];
  const relayResults = await Promise.all(
    RELAY_HOSTS.map(async (host) => {
      const [ping, relayHttp, ws, wsV1] = await Promise.all([
        httpProbe(`https://${host}/ping`),
        reachableProbe(`https://${host}/relay`),
        wsProbe(`wss://${host}/relay`, ["iroh-relay-v2", "iroh-relay-v1"]),
        wsProbe(`wss://${host}/relay`, ["iroh-relay-v1"]),
      ]);
      return `  ${host}\n    https /ping: ${ping}\n    https /relay: ${relayHttp}\n    wss (v2,v1): ${ws}\n    wss (v1): ${wsV1}`;
    }),
  );
  lines.push(...relayResults);
  lines.push("", "control websockets (non-iroh):");
  const controlResults = await Promise.all(
    CONTROL_WS.map(async (url) => `  ${url}: ${await wsProbe(url)}`),
  );
  lines.push(...controlResults);
  lines.push("");
  lines.push(`dns.iroh.link: ${await httpProbe("https://dns.iroh.link/")}`);
  lines.push(`general https: ${await reachableProbe("https://www.google.com/generate_204")}`);
  const text = lines.join("\n");
  if (out) out.textContent = text;
  log("diagnostics complete", "ok");
  return text;
}

async function connectToPeer(rawEndpointId) {
  const endpointId = (rawEndpointId ?? "").replace(/\s+/g, "");
  if (!endpointId) {
    showConnectError("Paste the other device's endpoint id first.");
    return;
  }
  if (!ENDPOINT_ID_RE.test(endpointId)) {
    showConnectError(
      `That does not look like an endpoint id: expected 64 hex characters, got ${endpointId.length}.`,
    );
    log("invalid endpoint id", "error");
    return;
  }
  if (!node) {
    showConnectError("The app is still starting up; try again in a moment.");
    return;
  }
  showConnectError("");
  log(`dialing ${endpointId} …`);
  try {
    await node.connect(endpointId);
    activePeer = endpointId;
    markDesired(endpointId);
    log(`connected to ${endpointId}`, "ok");
  } catch (err) {
    const message = String(err);
    showConnectError(
      `Could not connect to ${endpointId.slice(0, 8)}…: ${message}. ` +
        "Make sure the page is open on the other device and the id is exact.",
    );
    log(`connect failed: ${message}`, "error");
  }
}

function showConnectError(message) {
  const el = $("#connect-error");
  if (!el) return;
  el.textContent = message ?? "";
  el.hidden = !message;
}

function handleEvent(event) {
  const id = event.endpoint_id;
  if (event.type === "accepted" || event.type === "connected") {
    peers.set(id, event.type);
    if (!activePeer) activePeer = id;
    const timer = reconnectTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.delete(id);
    }
    reconnectAttempts.delete(id);
    log(`${event.type}: ${id}`, "ok");
  } else if (event.type === "closed") {
    peers.delete(id);
    if (activePeer === id) activePeer = null;
    log(`closed: ${id}${event.error ? ` (${event.error})` : ""}`);
    if (desiredPeers.has(id)) {
      log(`connection lost; will retry ${id.slice(0, 8)}… when possible`, "error");
      scheduleReconnect(id);
    }
  }
  telemetry.peers = peers.size;
  renderPeers();
}

function renderPeers() {
  const list = $("#peer-list");
  list.innerHTML = "";
  if (peers.size === 0) {
    list.textContent = "none";
    return;
  }
  for (const [id, kind] of peers) {
    const item = document.createElement("div");
    item.className = "peer";
    item.textContent = `${id} (${kind})${id === activePeer ? " ← sending" : ""}`;
    list.appendChild(item);
  }
}

async function consumeAudio() {
  const reader = node.audio().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    telemetry.framesReceived += 1;
    telemetry.bytesReceived += value.byteLength;
    if (playbackNode) {
      playbackNode.port.postMessage(value.buffer, [value.buffer]);
    }
  }
}

async function consumeEvents() {
  const reader = node.events().getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) handleEvent(value);
  }
}

function renderTelemetry() {
  telemetry.inputDb = dbFromRms(telemetry.inputRms);
  telemetry.outputDb = dbFromRms(telemetry.outputRms);
  $("#state").textContent = telemetry.state;
  $("#peers").textContent = String(telemetry.peers);
  $("#frames-sent").textContent = String(telemetry.framesSent);
  $("#frames-received").textContent = String(telemetry.framesReceived);
  $("#bytes-sent").textContent = String(telemetry.bytesSent);
  $("#bytes-received").textContent = String(telemetry.bytesReceived);
  $("#input-db").textContent = Number.isFinite(telemetry.inputDb)
    ? telemetry.inputDb.toFixed(1)
    : "-inf";
  $("#output-db").textContent = Number.isFinite(telemetry.outputDb)
    ? telemetry.outputDb.toFixed(1)
    : "-inf";
  updateAudioAlert();
}

async function main() {
  log("initialising wasm …");
  await init();

  // A stable per-tab secret keeps the endpoint id across a mobile reload.
  const savedSecret = sessionStorage.getItem(SECRET_STORAGE_KEY);
  const secretBytes = savedSecret ? hexToBytes(savedSecret) : new Uint8Array(0);
  node = await MicNode.spawn(secretBytes);
  if (secretBytes.length !== 32) {
    try {
      sessionStorage.setItem(SECRET_STORAGE_KEY, bytesToHex(node.secret_key()));
    } catch {
      /* ignore */
    }
  }
  const endpointId = node.endpoint_id();
  $("#endpoint-id").textContent = endpointId;
  $("#connect-link").href = `?connect=${endpointId}`;
  telemetry.state = "idle";
  log(`endpoint bound: ${endpointId}`, "ok");

  const params = new URLSearchParams(location.search);
  const autoConnect = params.get("connect");
  if (autoConnect) {
    $("#connect-id").value = autoConnect;
  }

  $("#copy-btn").onclick = () => {
    navigator.clipboard?.writeText(endpointId);
    log("endpoint id copied");
  };
  $("#mic-btn").onclick = () => startCapture("mic").catch((err) => log(`microphone error: ${err}`, "error"));
  $("#tone-btn").onclick = () => startCapture("tone").catch((err) => log(`audio error: ${err}`, "error"));
  $("#listen-btn").onclick = () => startListening().catch((err) => log(`audio error: ${err}`, "error"));
  $("#diag-btn").onclick = () => runDiagnostics().catch((err) => log(`diagnostics failed: ${err}`, "error"));
  $("#diag-copy-btn").onclick = () => {
    navigator.clipboard?.writeText($("#diagnostics")?.textContent ?? "");
    log("diagnostics copied");
  };
  $("#connect-form").onsubmit = (event) => {
    event.preventDefault();
    connectToPeer($("#connect-id").value);
  };
  $("#disconnect-btn").onclick = () => disconnectAll();

  consumeEvents();
  consumeAudio();

  // Resume/reconnect immediately on load: mobile browsers freeze background
  // tabs and may reload them, so this restores the session automatically.
  handleResume();
  const toRestore = new Set(desiredPeers);
  if (autoConnect && ENDPOINT_ID_RE.test(autoConnect)) {
    toRestore.delete(autoConnect);
    connectToPeer(autoConnect);
  }
  for (const id of toRestore) scheduleReconnect(id, true);

  setInterval(renderTelemetry, 250);
  renderPeers();
  renderTelemetry();

  window.__irohMic = {
    get endpointId() {
      return endpointId;
    },
    get telemetry() {
      return { ...telemetry };
    },
    get peers() {
      return [...peers.keys()];
    },
    get activePeer() {
      return activePeer;
    },
    start: (mode) => startCapture(mode),
    listen: () => startListening(),
    diagnostics: () => runDiagnostics(),
    connect: (id) => connectToPeer(id),
    disconnect: () => disconnectAll(),
    resume: () => handleResume(),
    get desiredPeers() {
      return [...desiredPeers];
    },
    get node() {
      return node;
    },
  };
}

main().catch((err) => {
  log(`fatal: ${err}`, "error");
  console.error(err);
});
