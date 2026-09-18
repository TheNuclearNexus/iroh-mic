//! Shared (native + wasm) iroh node and audio protocol.
//!
//! The protocol is deliberately tiny: an iroh connection is established by
//! endpoint id, the sender opens one unidirectional QUIC stream and writes
//! length-prefixed PCM frames, and the receiver reads those frames and hands
//! them to the frontend. Streams (rather than datagrams) are used because they
//! are the transport path proven to work in browsers today.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Result, anyhow};
use async_channel::{Receiver, Sender};
use bytes::Bytes;
use iroh::{
    Endpoint, EndpointId,
    endpoint::{Connection, SendStream},
    protocol::{AcceptError, ProtocolHandler, Router},
};
use n0_future::{StreamExt, boxed::BoxStream, task};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, broadcast};
use tokio_stream::wrappers::BroadcastStream;
use tracing::{info, warn};

/// Application protocol identifier negotiated by every peer.
pub const ALPN: &[u8] = b"iroh-mic/audio/0";

/// Largest PCM frame we are willing to read from a peer. 64 KiB is far above
/// any realistic 10-40 ms frame and bounds a malformed length prefix.
const MAX_FRAME_LEN: usize = 64 * 1024;

/// Connection lifecycle notifications for the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ConnectionEvent {
    Accepted {
        endpoint_id: EndpointId,
    },
    Connected {
        endpoint_id: EndpointId,
    },
    Closed {
        endpoint_id: EndpointId,
        error: Option<String>,
    },
}

struct PeerState {
    connection: Connection,
    /// Lazily opened audio stream. The first `send_audio` call creates it.
    send: Option<SendStream>,
}

struct Shared {
    peers: Mutex<HashMap<EndpointId, PeerState>>,
    audio_tx: Sender<Bytes>,
    events: broadcast::Sender<ConnectionEvent>,
}

/// A node that can accept and initiate iroh connections carrying audio.
#[derive(Clone)]
pub struct MicNode {
    router: Router,
    shared: Arc<Shared>,
    audio_rx: Receiver<Bytes>,
}

impl MicNode {
    /// Bind an iroh endpoint and start accepting incoming audio connections.
    ///
    /// Passing a `secret` keeps the endpoint id stable across reloads, which
    /// lets mobile browsers re-establish a suspended session under the same
    /// address.
    pub async fn spawn(secret: Option<iroh::SecretKey>) -> Result<Self> {
        let mut builder = Endpoint::builder(iroh::endpoint::presets::N0);
        if let Some(secret) = secret {
            builder = builder.secret_key(secret);
        }
        let endpoint = builder.alpns(vec![ALPN.to_vec()]).bind().await?;

        let (audio_tx, audio_rx) = async_channel::bounded(512);
        let (events, _) = broadcast::channel(256);
        let shared = Arc::new(Shared {
            peers: Mutex::new(HashMap::new()),
            audio_tx,
            events,
        });

        let router = Router::builder(endpoint)
            .accept(
                ALPN,
                AudioProtocol {
                    shared: shared.clone(),
                },
            )
            .spawn();

        info!(endpoint_id = %router.endpoint().id(), "iroh-mic endpoint bound");
        Ok(Self {
            router,
            shared,
            audio_rx,
        })
    }

    /// This node's endpoint id (the address peers dial).
    pub fn local_id(&self) -> EndpointId {
        self.router.endpoint().id()
    }

    /// The 32-byte secret key backing this endpoint, so the frontend can keep
    /// the endpoint id stable across reloads.
    pub fn secret_key(&self) -> [u8; 32] {
        self.router.endpoint().secret_key().to_bytes()
    }

    /// Close a peer connection (used when the user stops reconnecting).
    pub async fn disconnect(&self, endpoint_id: EndpointId) -> Result<()> {
        if let Some(peer) = self.shared.peers.lock().await.remove(&endpoint_id) {
            peer.connection.close(0u8.into(), b"disconnected");
        }
        Ok(())
    }

    /// Stream of incoming/outgoing connection lifecycle events.
    pub fn events(&self) -> BoxStream<ConnectionEvent> {
        let rx = self.shared.events.subscribe();
        Box::pin(BroadcastStream::new(rx).filter_map(|event| event.ok()))
    }

    /// Stream of PCM frames received from every connected peer.
    pub fn audio(&self) -> BoxStream<Bytes> {
        Box::pin(self.audio_rx.clone())
    }

    /// Dial a peer by endpoint id and register it for audio.
    pub async fn connect(&self, endpoint_id: EndpointId) -> Result<()> {
        let connection = self.router.endpoint().connect(endpoint_id, ALPN).await?;
        info!(%endpoint_id, "connected");
        self.shared
            .events
            .send(ConnectionEvent::Connected { endpoint_id })
            .ok();
        self.register(endpoint_id, connection).await;
        Ok(())
    }

    /// Send one PCM frame to a connected peer, opening the audio stream on
    /// first use.
    pub async fn send_audio(&self, endpoint_id: EndpointId, frame: Vec<u8>) -> Result<()> {
        if frame.is_empty() {
            return Ok(());
        }
        if frame.len() > MAX_FRAME_LEN {
            return Err(anyhow!("frame too large: {} bytes", frame.len()));
        }

        let mut peers = self.shared.peers.lock().await;
        let peer = peers
            .get_mut(&endpoint_id)
            .ok_or_else(|| anyhow!("not connected to {endpoint_id}"))?;
        if peer.send.is_none() {
            peer.send = Some(peer.connection.open_uni().await?);
        }
        let send = peer.send.as_mut().expect("just opened");

        let mut buf = Vec::with_capacity(4 + frame.len());
        buf.extend_from_slice(&(frame.len() as u32).to_be_bytes());
        buf.extend_from_slice(&frame);
        send.write_all(&buf).await?;
        Ok(())
    }

    /// Store a connection and start pumping its audio into [`MicNode::audio`].
    async fn register(&self, endpoint_id: EndpointId, connection: Connection) {
        {
            let mut peers = self.shared.peers.lock().await;
            peers.insert(
                endpoint_id,
                PeerState {
                    connection: connection.clone(),
                    send: None,
                },
            );
        }
        spawn_audio_reader(self.shared.clone(), connection.clone());
        spawn_close_monitor(self.shared.clone(), connection, endpoint_id);
    }
}

fn spawn_audio_reader(shared: Arc<Shared>, connection: Connection) {
    task::spawn(async move {
        loop {
            match connection.accept_uni().await {
                Ok(mut recv) => {
                    let shared = shared.clone();
                    task::spawn(async move {
                        loop {
                            let mut len_buf = [0u8; 4];
                            if recv.read_exact(&mut len_buf).await.is_err() {
                                break;
                            }
                            let len = u32::from_be_bytes(len_buf) as usize;
                            if len == 0 || len > MAX_FRAME_LEN {
                                warn!(len, "dropping malformed audio frame");
                                break;
                            }
                            let mut frame = vec![0u8; len];
                            if recv.read_exact(&mut frame).await.is_err() {
                                break;
                            }
                            if shared.audio_tx.send(Bytes::from(frame)).await.is_err() {
                                break;
                            }
                        }
                    });
                }
                Err(err) => {
                    info!("audio stream accept loop ended: {err}");
                    break;
                }
            }
        }
    });
}

fn spawn_close_monitor(shared: Arc<Shared>, connection: Connection, endpoint_id: EndpointId) {
    task::spawn(async move {
        let reason = connection.closed().await;
        shared.peers.lock().await.remove(&endpoint_id);
        let error = Some(reason.to_string());
        info!(%endpoint_id, "connection closed: {reason}");
        shared
            .events
            .send(ConnectionEvent::Closed { endpoint_id, error })
            .ok();
    });
}

struct AudioProtocol {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for AudioProtocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioProtocol").finish_non_exhaustive()
    }
}

impl ProtocolHandler for AudioProtocol {
    async fn accept(&self, connection: Connection) -> std::result::Result<(), AcceptError> {
        let endpoint_id = connection.remote_id();
        info!(%endpoint_id, "accepted audio connection");

        {
            let mut peers = self.shared.peers.lock().await;
            peers.insert(
                endpoint_id,
                PeerState {
                    connection: connection.clone(),
                    send: None,
                },
            );
        }
        self.shared
            .events
            .send(ConnectionEvent::Accepted { endpoint_id })
            .ok();
        spawn_audio_reader(self.shared.clone(), connection.clone());

        // Keep the accept future alive for the lifetime of the connection so
        // the router does not consider this handler finished.
        let reason = connection.closed().await;
        self.shared.peers.lock().await.remove(&endpoint_id);
        self.shared
            .events
            .send(ConnectionEvent::Closed {
                endpoint_id,
                error: Some(reason.to_string()),
            })
            .ok();
        Ok(())
    }
}
