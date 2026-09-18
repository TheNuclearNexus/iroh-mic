import init, { MicNode } from "./wasm/iroh_mic.js";

const SAMPLE_RATE = 48000;
const FRAME_SAMPLES = 480; // 10 ms at 48 kHz
const MAX_QUEUED_FRAMES = 20; // ~200 ms of backlog before we drop oldest

const telemetry = {
  state: "booting",
  peers: 0,
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

async function startAudio(mode) {
  if (ctx) return;
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.audioWorklet.addModule("./capture-worklet.js");
  await ctx.audioWorklet.addModule("./playback-worklet.js");
  await ctx.resume();

  playbackNode = new AudioWorkletNode(ctx, "playback", { outputChannelCount: [1] });
  playbackNode.port.onmessage = (event) => {
    telemetry.outputRms = event.data.rms;
  };
  playbackNode.connect(ctx.destination);

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
}

async function connectToPeer(endpointId) {
  if (!endpointId) return;
  log(`dialing ${endpointId} …`);
  try {
    await node.connect(endpointId);
    activePeer = endpointId;
    log(`connected to ${endpointId}`, "ok");
  } catch (err) {
    log(`connect failed: ${err}`, "error");
  }
}

function handleEvent(event) {
  const id = event.endpoint_id;
  if (event.type === "accepted" || event.type === "connected") {
    peers.set(id, event.type);
    if (!activePeer) activePeer = id;
    log(`${event.type}: ${id}`, "ok");
  } else if (event.type === "closed") {
    peers.delete(id);
    if (activePeer === id) activePeer = null;
    log(`closed: ${id}${event.error ? ` (${event.error})` : ""}`);
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
}

async function main() {
  log("initialising wasm …");
  await init();
  node = await MicNode.spawn();
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
  $("#mic-btn").onclick = () => startAudio("mic").catch((err) => log(`microphone error: ${err}`, "error"));
  $("#tone-btn").onclick = () => startAudio("tone").catch((err) => log(`audio error: ${err}`, "error"));
  $("#connect-form").onsubmit = (event) => {
    event.preventDefault();
    connectToPeer($("#connect-id").value.trim());
  };

  consumeEvents();
  consumeAudio();
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
    start: (mode) => startAudio(mode),
    connect: (id) => connectToPeer(id),
  };
}

main().catch((err) => {
  log(`fatal: ${err}`, "error");
  console.error(err);
});
