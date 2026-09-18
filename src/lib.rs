//! iroh-mic: stream microphone audio between browser peers over iroh.

pub mod node;

#[cfg(all(target_family = "wasm", target_os = "unknown"))]
pub mod wasm;
