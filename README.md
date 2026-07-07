# KNR Reader

A fast desktop reader for **PDF**, **CBZ** and **CBR** files, built for Windows and macOS with [Tauri 2](https://tauri.app), React and PDF.js.

## Features

**Comics (CBZ / CBR)**

- Single or double-page layout, with a "cover alone" option so spreads line up like print
- Fit to window width or height
- Reading direction toggle — left-to-right or right-to-left (manga)
- Zoom (buttons, `+`/`-`/`0` keys, or Ctrl/Cmd + mouse wheel)
- Natural page ordering (`page2` before `page10`), file-content sniffing so mislabeled archives still open
- Keyboard navigation: arrows (direction-aware), Space, PgUp/PgDn, Home/End

**PDF**

- Continuous scrolling with lazy page rendering (large documents stay fast)
- Zoom, fit-width and fit-page modes
- Text selection and **highlighting** in four colours — enable highlight mode, select text; click a highlight to remove it
- Highlights are persisted per document

**General**

- Remembers your place and view settings per file
- Recent files on the start screen
- Drag & drop a file anywhere in the window to open it

## Architecture

| Layer | Tech | Role |
|---|---|---|
| UI | React + TypeScript + Vite | Viewers, toolbars, view-mode logic |
| PDF engine | PDF.js | Rendering, text layer, highlight geometry |
| Backend | Rust (Tauri 2) | Archive handling, page streaming, state persistence |

- **CBZ** pages are read straight out of the zip on demand (cheap random access).
- **CBR** archives are extracted once to a temporary directory when opened (RAR has no cheap random access) and pages are served from disk. The temp dir is cleaned up when the document closes.
- Comic pages stream to the UI as binary IPC responses; the viewer keeps a small blob cache with prefetch of neighbouring pages and evicts distant ones.
- Per-document state (last page, layout, fit, zoom, direction, PDF highlights) is stored as JSON under the app data directory, keyed by a hash of the file path. PDF highlights live in this sidecar store; they are not embedded into the PDF file itself.

## Development

Prerequisites: [Node 20+](https://nodejs.org), [Rust](https://rustup.rs), and the [Tauri platform prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run tauri dev
```

Run the Rust tests:

```sh
cargo test --manifest-path src-tauri/Cargo.toml
```

## Building installers

```sh
npm run tauri build
```

Produces `.msi`/`.exe` on Windows and `.dmg`/`.app` on macOS under `src-tauri/target/release/bundle/`. CI builds all of these for every push to `main` (see `.github/workflows/build.yml`).

## Licensing notes

- PDF rendering uses PDF.js (Apache-2.0).
- CBR support uses the `unrar` crate, which builds on the freeware unrar source; its license permits reading RAR archives but not building a RAR compressor — fine for a reader.
