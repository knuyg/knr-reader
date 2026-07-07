import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openDocument } from "./ipc";
import type { DocumentInfo } from "./types";
import ComicViewer from "./components/ComicViewer";
import PdfViewer from "./components/PdfViewer";

interface OpenDoc {
  path: string;
  name: string;
  info: DocumentInfo;
}

interface RecentFile {
  path: string;
  name: string;
}

const RECENT_KEY = "knr-recent-files";

function loadRecent(): RecentFile[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export default function App() {
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentFile[]>(loadRecent);

  const loadPath = useCallback(async (path: string) => {
    setError(null);
    try {
      const info = await openDocument(path);
      const name = fileName(path);
      setDoc({ path, name, info });
      setRecent((prev) => {
        const next = [
          { path, name },
          ...prev.filter((r) => r.path !== path),
        ].slice(0, 8);
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const openFile = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [
        { name: "All supported", extensions: ["pdf", "cbz", "cbr"] },
        { name: "PDF documents", extensions: ["pdf"] },
        { name: "Comic archives", extensions: ["cbz", "cbr"] },
      ],
    });
    if (typeof path === "string") await loadPath(path);
  }, [loadPath]);

  // Open files dropped onto the window.
  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && event.payload.paths.length > 0) {
        void loadPath(event.payload.paths[0]);
      }
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [loadPath]);

  // Ctrl/Cmd+O anywhere opens the file picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile]);

  const close = useCallback(() => setDoc(null), []);

  if (!doc) {
    return (
      <div className="welcome">
        <h1>KNR Reader</h1>
        <p className="subtitle">PDF · CBZ · CBR</p>
        <button className="primary" onClick={openFile}>
          Open a file…
        </button>
        <p className="hint">or drop a file anywhere in this window (Ctrl+O)</p>
        {error && <div className="error-banner">{error}</div>}
        {recent.length > 0 && (
          <div className="recent">
            <h2>Recent</h2>
            <ul>
              {recent.map((r) => (
                <li key={r.path}>
                  <button onClick={() => loadPath(r.path)} title={r.path}>
                    {r.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <button onClick={close} title="Back to start screen">
          ← Close
        </button>
        <span className="doc-name" title={doc.path}>
          {doc.name}
        </span>
        <button onClick={openFile} title="Open another file (Ctrl+O)">
          Open…
        </button>
      </header>
      {error && <div className="error-banner">{error}</div>}
      {doc.info.kind === "comic" ? (
        <ComicViewer
          key={doc.path}
          id={doc.info.id}
          pageCount={doc.info.pageCount}
          pageNames={doc.info.pageNames}
          docPath={doc.path}
        />
      ) : (
        <PdfViewer key={doc.path} docPath={doc.path} />
      )}
    </div>
  );
}
