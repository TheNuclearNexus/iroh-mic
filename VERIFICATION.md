# Verification runbook

Exact steps to reproduce the end-to-end proof that two browser peers connect
over iroh and one streams audio to the other. Run from the repo root.

## 0. Prerequisites

```sh
rustup target add wasm32-unknown-unknown
wasm-pack --version        # 0.13.x; installs the matching wasm-bindgen CLI
node --version             # only for the bundled static server
```

## 1. Build the static site

```sh
npm run build:release       # or: ./scripts/build-wasm.sh --release
```

Expected: the build succeeds and `public/` contains the complete site, with

```sh
ls public public/wasm
# public/index.html  main.js  style.css  capture-worklet.js  playback-worklet.js
# public/wasm/iroh_mic.js  public/wasm/iroh_mic_bg.wasm
```

No server process is started by the build. `scripts/build-wasm.sh` unsets host
`AR`/`RANLIB`/`CC`/`CFLAGS` (which break `ring`'s wasm build on
conda/homebrew machines) before invoking `wasm-pack`.

## 2. Serve the static directory

```sh
npm run serve               # http://127.0.0.1:8080, no dependencies
```

`127.0.0.1` is a secure context, which Web Audio and WebTransport require.

## 3. End-to-end check with two browser peers (automated)

This is what was executed for the recorded evidence below. It uses the
`agent_browser` tool, but the same steps work by hand in two tabs/devices.

1. Open `http://127.0.0.1:8080/` and wait for the endpoint id to appear.
   * Check: `#endpoint-id` is a 64-char hex string, `#state` is `idle`, and
     there are no page errors.
2. Click **start test tone** on tab 1.
   * Check: `#state` = `capturing (test tone)` and `#input-db` is roughly
     `-17` dBFS (non-silent source).
3. Open a second tab to the same URL and click **start test tone** there too.
   * The second tab needs the playback graph, which is created when audio
     starts.
4. In tab 1, paste tab 2's endpoint id into the peer box and press
   **connect & send**.
   * Check: within a few seconds `#peers` = `1` and the log shows
     `connected to <id>`.
5. Wait ~5 s and read telemetry on both tabs.

Expected on both peers (values grow continuously):

| field | expectation |
| --- | --- |
| `state` | `capturing (test tone)` |
| `peers` | `1` |
| `frames sent` | > 0 (hundreds–thousands) |
| `frames received` | > 0 (hundreds–thousands) |
| `bytes sent` / `bytes received` | > 0 (≈ 960 bytes/frame) |
| `output level (dBFS)` | ≈ `-17` (non-silent, above the noise floor) |

There must be no uncaught console errors. iroh may use a direct path or the
public relay; either satisfies the check.

## 4. Microphone code path

Launch the browser with Chrome's fake media device (and auto-grant):

```
--use-fake-ui-for-media-stream
--use-fake-device-for-media-stream
```

Open two tabs, click **start microphone** in both, connect, and confirm frames
flow as in step 5.

**Known limitation (recorded 2026-09, Chrome 153.0.8010.36):** in this
environment Chrome's fake audio input produces silence (measured RMS ≈ 0 both
with the default device and with
`--use-file-for-fake-audio-capture=/tmp/iroh-mic-tone.wav`). The microphone
code path therefore completes (`getUserMedia` → `MediaStreamSource` →
`AudioWorklet` → iroh → receiver playback) and transports frames, but the
non-silent output assertion is proven with the built-in test tone (step 3).
On real hardware with a real microphone, `#input-db` is non-silent and the
receiver's `#output-db` follows.

To generate the WAV used by the fake-audio flag:

```sh
node scripts/make-test-tone.mjs /tmp/iroh-mic-tone.wav
```

## 6. Mobile resume / reconnect

Mobile browsers freeze background tabs and may reload them. Verify recovery:

1. Reload a connected tab. The endpoint id is unchanged and the peer connection
   is re-established automatically: the log shows `reconnected to …`,
   `#peers` = `1`, and the frame counters keep increasing.
2. Force a drop from the console:
   `await window.__irohMic.node.disconnect("<peerId>")`. The log shows
   `connection lost; will retry …` followed by `reconnected to …`.
3. Open two tabs: they get **different** endpoint ids (separate
   `sessionStorage`); the same tab keeps its id across reloads.

## 7. Human spot check (recommended)

Open the page on two real devices (or two tabs with a real mic), connect by
endpoint id, and confirm audio is audible on the receiver. Headphones avoid
feedback on a single machine.

## Troubleshooting

* **404 at `https://thenuclearnexus.github.io/`** — the account root is served by
the `TheNuclearNexus.github.io` user-site repo, which redirects to
`/iroh-mic/`. The app itself always lives at
`https://thenuclearnexus.github.io/iroh-mic/`.
* **`favicon.ico` 404 in the console** — fixed by an inline SVG icon in
`index.html`; browsers no longer request `/favicon.ico`.
* **Connect fails** — the peer must have the page open and the endpoint id must
be exactly 64 hex characters. The UI now validates the id and shows the
underlying error (for example a discovery `404` when the peer is offline or
its record has expired).

## Recorded evidence

Run date: 2026-09-18, Chrome 153.0.8010.36 (headless), macOS arm64,
iroh 1.2.0. Two tabs in one browser context, connected over iroh.

Test-tone run (non-silent, both directions):

* sender: `framesSent=1846`, `bytesSent=1772160`, `framesReceived=1834`,
  `bytesReceived=1760640`, `outputDb≈-17.0`
* receiver: `framesReceived=2278`, `bytesReceived=2186880`,
  `outputDb≈-16.99`, `peers=1`
* page errors: none

Microphone-path run (fake device, silent samples — see limitation above):

* sender: `state=capturing (microphone)`, `framesSent=1616`,
  `framesReceived=1591`, `bytesSent=1551360`, `bytesReceived=1527360`
* receiver: `state=capturing (microphone)`, `framesReceived>0`
* page errors: none
