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

## Limitations

* Audio is uncompressed 48 kHz mono PCM (~768 kbit/s per direction). That is
  fine for a demo over the relay but a production app would negotiate Opus via
  a codec such as `iroh-roq`/`iroh-live`.
* One audio stream per connection and a fixed 10 ms frame size.
* The receiver trusts any peer that dials it (the ALPN is public); add an
  accept filter or shared secret before exposing this beyond a demo.

See [VERIFICATION.md](./VERIFICATION.md) for the exact end-to-end test procedure
and recorded evidence.
