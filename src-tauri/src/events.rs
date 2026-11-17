//! Centralized backend→frontend event emission.
//!
//! All backend events should go through `emit_to_frontend`, which targets
//! the main webview explicitly via `emit_to` and falls back to a global
//! broadcast if the main webview is not yet available (e.g. during early
//! setup before the main window exists).
//!
//! Routing through a single helper also gives us one place to thread a
//! per-window label through when multi-window support lands (roadmap
//! §4.3.8 / B12 follow-up).

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const MAIN_WINDOW_LABEL: &str = "main";

/// Emit an event targeting the main webview, falling back to a global
/// emit if `emit_to` fails (e.g. main window not yet created).
///
/// The floating tasks strip (`"float"`) deliberately does **not** route through
/// here: this function writes `"main"` into every frame, and the strip is a
/// second webview that must not receive the raw stream. Its data is derived by
/// the main window and pushed with `emit_to("float", "float:state", ..)`.
pub fn emit_to_frontend<S>(app: &AppHandle, event: &str, payload: S) -> Result<(), String>
where
    S: Serialize + Clone,
{
    // Mirror onto the remote hub so a connected phone sees the exact same
    // event stream as the desktop WebView.
    crate::remote::publish(event, &payload);
    if let Err(e1) = app.emit_to(MAIN_WINDOW_LABEL, event, payload.clone()) {
        if let Err(e2) = app.emit(event, payload) {
            return Err(format!("emit_to failed: {e1}, emit failed: {e2}"));
        }
    }
    Ok(())
}
