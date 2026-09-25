# iroh-mic

A **static** browser webapp that dials peers **by public key** with
[iroh](https://iroh.computer) and streams a live microphone feed from one
device to another. There is no backend and no signaling server: connectivity
comes entirely from iroh's built-in discovery and relay, and the deployable
artifact is a plain static directory (HTML/CSS/JS + WebAssembly).

Live demo: <https://thenuclearnexus.github.io/iroh-mic/> (the account root
<https://thenuclearnexus.github.io/> redirects there).

```
 browser A (sender)                     browser B (receiver)
 ┌─────────────────────┐   iroh/QUIC   ┌─────────────────────┐
 │ getUserMedia / tone │  ───────────► │ AudioWorklet player │
 │ AudioWorklet capture│               │                     │
 └─────────┬───────────┘               └──────────▲──────────┘
           │ length-prefixed PCM frames            │
           └──────────── iroh Endpoint ────────────┘
                     (relay fallback)
```

## How it works

* The Rust crate is compiled to `wasm32-unknown-unknown` and exposes a small
  `MicNode` class via `wasm-bindgen` (`src/wasm.rs`).
* `MicNode` binds an iroh `Endpoint` with the N0 preset (public discovery +
  relay) and accepts the ALPN `iroh-mic/audio/0` (`src/node.rs`).
* Each peer is identified by its Ed25519 endpoint id. Connect by pasting the
  other peer's id into the UI.
* Audio is captured at 48 kHz mono in an `AudioWorklet`, packed into 10 ms
  frames (480 samples, 16-bit little-endian), and written to a unidirectional
  QUIC stream as length-prefixed frames.
* The receiver reads frames from `accept_uni()`, forwards them to a playback
  `AudioWorklet`, which buffers them in a ring buffer and renders to the audio
  output. Both sides report counters and RMS/dBFS levels in the UI.
* No audio is ever written to disk or sent anywhere except the connected peer.

## Requirements

* Rust with the wasm target: `rustup target add wasm32-unknown-unknown`
* [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (it installs the matching
  `wasm-bindgen` CLI automatically; the crate pins `wasm-bindgen`)
* Node.js only if you use the bundled static server (`scripts/serve.mjs`)

## Build

```sh
npm run build          # debug wasm (fast iteration)
npm run build:release  # optimized wasm (smaller)
# or directly:
./scripts/build-wasm.sh --release
```

The build emits the complete static site:

```
public/
  index.html  main.js  style.css
  capture-worklet.js  playback-worklet.js
  wasm/iroh_mic.js  wasm/iroh_mic_bg.wasm
```

The `scripts/build-wasm.sh` wrapper strips host `AR`/`RANLIB`/`CC`/`CFLAGS`
exports (common with conda/miniforge/homebrew) that otherwise break compiling
`ring` for wasm, and points the wasm target at LLVM's archiver when available.

## Run locally

```sh
npm run serve   # http://127.0.0.1:8080, zero dependencies
```

Open the page in two tabs or two devices, start audio in both (real microphone
or the built-in 440 Hz test tone), then paste one tab's endpoint id into the
other and press **connect & send**. Received audio plays automatically.

`localhost` / `127.0.0.1` count as secure contexts, which the Web Audio API and
WebTransport require. Serve over HTTPS when deploying.

## Deploying

Copy `public/` to any static host (GitHub Pages, Netlify, S3, `nginx`, …). No
server-side code is required. The page must be served over HTTPS (or
`localhost`) for microphone access and WebTransport.

## Connectivity and relay fallback

Browser peers cannot open raw UDP sockets, so iroh in the browser connects to
its relay over WebTransport. When both peers can reach each other directly the
traffic is peer-to-peer; otherwise iroh keeps the connection alive through the
public N0 relay. Either way the application code is unchanged and still only
dials by endpoint id. See [iroh's docs](https://iroh.computer/docs) for relay
deployment/self-hosting options.

## Hearing the other side

Browsers only start audio after a **user gesture** on that device. On the
receiving device:

* press **listen** (no microphone permission needed) or **start microphone** /
  **start test tone**, or simply tap anywhere on the page;
* if audio is arriving but the device has not enabled playback, a yellow
  **Playing muted** banner appears;
* on iPhone also check the side mute switch and the volume (Web Audio can be
  silenced by the hardware mute switch).

The telemetry panel shows `output level (dBFS)`: `-inf` means nothing is being
rendered to the audio output on this device, while a value near `-17` means
audio is playing.

### Output device

The **output device** dropdown routes received audio to a specific speaker or
headset using `AudioContext.setSinkId` (Chrome and Edge; Safari and Firefox do
not expose it, so the control is disabled there).

Browsers hide output names until the page is granted media access, so at first
the list shows a single generic entry such as `Output 1`. The button next to
the dropdown adapts to the browser:

* **choose output…** — the browser supports the native output picker
  (`MediaDevices.selectAudioOutput`), so you can pick a speaker/headset directly.
* **reveal names…** — the browser has no output picker, so it needs one media
  permission to unlock names. The prompt asks for a microphone; the track is
  stopped immediately and only used to reveal the device list.

Starting the microphone also reveals the names. Use **refresh** after plugging
in a headset.

## Mobile and background tabs

Mobile browsers freeze background tabs, drop the network session, and often
reload the page. iroh-mic is built to recover instead of pretending the
session survives:

* The endpoint key is kept in `sessionStorage`, so the endpoint id is **stable
  across a reload in the same tab** while each tab still gets its own identity.
* The app remembers the peers you connected to and automatically re-dials them
  when the tab becomes visible again, when the network returns, or after a
  reload.
* The `AudioContext` is resumed on return, and a screen wake lock is requested
  while streaming to reduce interruptions.

Use **disconnect** to stop auto-reconnecting. A backgrounded tab can still be
suspended by the OS; the design restores the session when you return rather
than trying to keep it alive.

## Diagnostics

If one device cannot connect, open the **Diagnostics** card on that device and
press **run network test**. It probes each iroh relay over HTTPS and WebSocket
(with and without the trailing-dot hostname) and checks `dns.iroh.link`, which
usually pinpoints whether the problem is the network, the browser, or the peer.
Use **copy result** to share the output.

## Limitations

* Audio is uncompressed 48 kHz mono PCM (~768 kbit/s per direction). That is
  fine for a demo over the relay but a production app would negotiate Opus via
  a codec such as `iroh-roq`/`iroh-live`.
* One audio stream per connection and a fixed 10 ms frame size.
* The receiver trusts any peer that dials it (the ALPN is public); add an
  accept filter or shared secret before exposing this beyond a demo.

See [VERIFICATION.md](./VERIFICATION.md) for the exact end-to-end test procedure
and recorded evidence.
