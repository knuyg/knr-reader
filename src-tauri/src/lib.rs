mod archive;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Response;
use tauri::{Manager, State};

use archive::{Comic, DocumentKind};

#[derive(Default)]
struct AppState {
    comics: Mutex<HashMap<u32, Comic>>,
    next_id: AtomicU32,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum DocumentInfo {
    #[serde(rename_all = "camelCase")]
    Pdf {},
    #[serde(rename_all = "camelCase")]
    Comic {
        id: u32,
        page_count: usize,
        page_names: Vec<String>,
    },
}

/// Open a document at `path`. PDFs are handled entirely by the frontend
/// (which fetches the raw bytes via `read_file_bytes`); comic archives are
/// opened here and kept in state so pages can be served on demand.
#[tauri::command]
fn open_document(state: State<'_, AppState>, path: String) -> Result<DocumentInfo, String> {
    let path = Path::new(&path);
    let comic = match archive::detect_kind(path)? {
        DocumentKind::Pdf => return Ok(DocumentInfo::Pdf {}),
        DocumentKind::Zip => archive::open_zip(path)?,
        DocumentKind::Rar => archive::open_rar(path)?,
    };

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let info = DocumentInfo::Comic {
        id,
        page_count: comic.page_count(),
        page_names: comic.page_names(),
    };
    state.comics.lock().unwrap().insert(id, comic);
    Ok(info)
}

/// Raw bytes of one page image, returned as a binary IPC response.
#[tauri::command]
fn get_comic_page(state: State<'_, AppState>, id: u32, index: usize) -> Result<Response, String> {
    let mut comics = state.comics.lock().unwrap();
    let comic = comics
        .get_mut(&id)
        .ok_or_else(|| format!("Comic {id} is not open"))?;
    comic.read_page(index).map(Response::new)
}

#[tauri::command]
fn close_comic(state: State<'_, AppState>, id: u32) {
    state.comics.lock().unwrap().remove(&id);
}

/// Raw bytes of any file (used by the frontend to feed PDF.js).
#[tauri::command]
fn read_file_bytes(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Cannot read {path}: {e}"))
}

/// Per-document state (last page, view settings, PDF highlights) is stored as
/// one JSON file per document under the app data dir, keyed by a hash of the
/// document's absolute path.
fn doc_state_file(app: &tauri::AppHandle, doc_path: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("doc-state");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let hash = Sha256::digest(doc_path.as_bytes());
    let mut name = String::with_capacity(32);
    for byte in &hash[..16] {
        name.push_str(&format!("{byte:02x}"));
    }
    Ok(dir.join(format!("{name}.json")))
}

#[tauri::command]
fn load_doc_state(app: tauri::AppHandle, doc_path: String) -> Result<Option<String>, String> {
    let file = doc_state_file(&app, &doc_path)?;
    match std::fs::read_to_string(file) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn save_doc_state(app: tauri::AppHandle, doc_path: String, data: String) -> Result<(), String> {
    let file = doc_state_file(&app, &doc_path)?;
    std::fs::write(file, data).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_document,
            get_comic_page,
            close_comic,
            read_file_bytes,
            load_doc_state,
            save_doc_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
