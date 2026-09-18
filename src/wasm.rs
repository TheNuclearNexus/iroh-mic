//! `wasm-bindgen` surface exposed to the browser frontend.

use anyhow::{Context, Result};
use bytes::Bytes;
use iroh::EndpointId;
use n0_future::{Stream, StreamExt};
use serde::Serialize;
use tracing::level_filters::LevelFilter;
use tracing_subscriber_wasm::MakeConsoleWriter;
use wasm_bindgen::{JsError, prelude::wasm_bindgen};
use wasm_streams::{ReadableStream, readable::sys::ReadableStream as JsReadableStream};

use crate::node;

#[wasm_bindgen(start)]
fn start() {
    console_error_panic_hook::set_once();

    tracing_subscriber::fmt()
        .with_max_level(LevelFilter::TRACE)
        .with_writer(MakeConsoleWriter::default().map_trace_level_to(tracing::Level::DEBUG))
        .without_time()
        .with_ansi(false)
        .init();

    tracing::info!("iroh-mic: logging initialised");
}

/// Browser handle to an iroh endpoint that sends and receives audio frames.
#[wasm_bindgen]
pub struct MicNode(node::MicNode);

#[wasm_bindgen]
impl MicNode {
    /// Bind a new endpoint using iroh's public relay defaults. Pass a 32-byte
    /// secret key to keep the endpoint id stable across reloads, or an empty
    /// array to generate a fresh one.
    pub async fn spawn(secret: Vec<u8>) -> Result<MicNode, JsError> {
        let secret = if secret.len() == 32 {
            let mut bytes = [0u8; 32];
            bytes.copy_from_slice(&secret);
            Some(iroh::SecretKey::from_bytes(&bytes))
        } else {
            None
        };
        Ok(MicNode(
            node::MicNode::spawn(secret).await.map_err(to_js_err)?,
        ))
    }

    /// This node's endpoint id, shown to the user so a peer can dial it.
    pub fn endpoint_id(&self) -> String {
        self.0.local_id().to_string()
    }

    /// The 32-byte secret key for persisting this endpoint's identity.
    pub fn secret_key(&self) -> Vec<u8> {
        self.0.secret_key().to_vec()
    }

    /// Status of each home relay connection.
    pub fn relay_status(&self) -> Vec<String> {
        self.0.relay_status()
    }

    /// Readable stream of connection lifecycle events (JSON objects).
    pub fn events(&self) -> JsReadableStream {
        let stream = self.0.events();
        into_json_stream(stream)
    }

    /// Readable stream of received PCM frames (`Uint8Array`).
    pub fn audio(&self) -> JsReadableStream {
        let stream = self.0.audio();
        into_bytes_stream(stream)
    }

    /// Dial a remote endpoint id.
    pub async fn connect(&self, endpoint_id: String) -> Result<(), JsError> {
        let endpoint_id = parse_endpoint_id(&endpoint_id)?;
        self.0.connect(endpoint_id).await.map_err(to_js_err)
    }

    /// Send one PCM frame to a connected peer.
    pub async fn send_audio(&self, endpoint_id: String, data: Vec<u8>) -> Result<(), JsError> {
        let endpoint_id = parse_endpoint_id(&endpoint_id)?;
        self.0
            .send_audio(endpoint_id, data)
            .await
            .map_err(to_js_err)
    }

    /// Close a peer connection.
    pub async fn disconnect(&self, endpoint_id: String) -> Result<(), JsError> {
        let endpoint_id = parse_endpoint_id(&endpoint_id)?;
        self.0.disconnect(endpoint_id).await.map_err(to_js_err)
    }
}

fn parse_endpoint_id(value: &str) -> Result<EndpointId, JsError> {
    value
        .parse()
        .with_context(|| format!("invalid endpoint id: {value}"))
        .map_err(to_js_err)
}

fn to_js_err(err: impl Into<anyhow::Error>) -> JsError {
    let err: anyhow::Error = err.into();
    JsError::new(&err.to_string())
}

fn into_json_stream<T: Serialize>(stream: impl Stream<Item = T> + 'static) -> JsReadableStream {
    let stream = stream.map(|event| Ok(serde_wasm_bindgen::to_value(&event).unwrap()));
    ReadableStream::from_stream(stream).into_raw()
}

fn into_bytes_stream(stream: impl Stream<Item = Bytes> + 'static) -> JsReadableStream {
    let stream = stream.map(|bytes| {
        let array = js_sys::Uint8Array::from(bytes.as_ref());
        Ok(wasm_bindgen::JsValue::from(array))
    });
    ReadableStream::from_stream(stream).into_raw()
}
