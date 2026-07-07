import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { closeComic, getComicPage, loadDocState, saveDocState } from "../ipc";
import type { ComicDocState, Direction, FitMode, Layout } from "../types";

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
};

function mimeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
/** Pages kept in the blob cache before distant ones are evicted. */
const CACHE_LIMIT = 20;

interface Props {
  id: number;
  pageCount: number;
  pageNames: string[];
  docPath: string;
}

export default function ComicViewer({
  id,
  pageCount,
  pageNames,
  docPath,
}: Props) {
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState<Layout>("single");
  const [coverAlone, setCoverAlone] = useState(true);
  const [fit, setFit] = useState<FitMode>("height");
  const [zoom, setZoom] = useState(1);
  const [direction, setDirection] = useState<Direction>("ltr");
  const [urls, setUrls] = useState<ReadonlyMap<number, string>>(new Map());
  const [restored, setRestored] = useState(false);
  const [pageInput, setPageInput] = useState("");

  const cacheRef = useRef(new Map<number, string>());
  const inflightRef = useRef(new Set<number>());
  const stageRef = useRef<HTMLDivElement>(null);

  // Group pages into spreads for the current layout. With "cover alone" the
  // first page is shown by itself so that double-page spreads line up the way
  // they do in print.
  const spreads = useMemo(() => {
    const out: number[][] = [];
    if (layout === "single") {
      for (let i = 0; i < pageCount; i++) out.push([i]);
    } else {
      let i = 0;
      if (coverAlone && pageCount > 0) {
        out.push([0]);
        i = 1;
      }
      for (; i < pageCount; i += 2) {
        out.push(i + 1 < pageCount ? [i, i + 1] : [i]);
      }
    }
    return out;
  }, [layout, coverAlone, pageCount]);

  const spreadIndex = useMemo(() => {
    const idx = spreads.findIndex((s) => s.includes(page));
    return idx === -1 ? 0 : idx;
  }, [spreads, page]);

  const visible = spreads[spreadIndex] ?? [];

  const goToPage = useCallback(
    (p: number) => setPage(Math.max(0, Math.min(pageCount - 1, p))),
    [pageCount],
  );
  const next = useCallback(() => {
    const s = spreads[spreadIndex + 1];
    if (s) setPage(s[0]);
  }, [spreads, spreadIndex]);
  const prev = useCallback(() => {
    const s = spreads[spreadIndex - 1];
    if (s) setPage(s[0]);
  }, [spreads, spreadIndex]);

  const zoomBy = useCallback((factor: number) => {
    setZoom((z) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z * factor)));
  }, []);

  // Restore per-document state once, then persist changes (debounced).
  useEffect(() => {
    let cancelled = false;
    loadDocState<ComicDocState>(docPath).then((s) => {
      if (cancelled) return;
      if (s) {
        if (s.page != null) setPage(Math.max(0, Math.min(s.page, pageCount - 1)));
        if (s.layout) setLayout(s.layout);
        if (s.coverAlone != null) setCoverAlone(s.coverAlone);
        if (s.fit) setFit(s.fit);
        if (s.zoom) setZoom(s.zoom);
        if (s.direction) setDirection(s.direction);
      }
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [docPath, pageCount]);

  useEffect(() => {
    if (!restored) return;
    const state: ComicDocState = {
      page,
      layout,
      coverAlone,
      fit,
      zoom,
      direction,
    };
    const t = setTimeout(() => saveDocState(docPath, state), 400);
    return () => clearTimeout(t);
  }, [restored, page, layout, coverAlone, fit, zoom, direction, docPath]);

  // Load the pages of the current spread plus its neighbours, and evict
  // blob URLs that have drifted far from the current position.
  useEffect(() => {
    const wanted = new Set<number>();
    for (const s of [
      spreads[spreadIndex - 1],
      spreads[spreadIndex],
      spreads[spreadIndex + 1],
    ]) {
      s?.forEach((p) => wanted.add(p));
    }

    for (const p of wanted) {
      if (cacheRef.current.has(p) || inflightRef.current.has(p)) continue;
      inflightRef.current.add(p);
      getComicPage(id, p)
        .then((buf) => {
          const url = URL.createObjectURL(
            new Blob([buf], { type: mimeFor(pageNames[p]) }),
          );
          cacheRef.current.set(p, url);
          setUrls(new Map(cacheRef.current));
        })
        .catch((e) => console.error(`Failed to load page ${p + 1}:`, e))
        .finally(() => inflightRef.current.delete(p));
    }

    if (cacheRef.current.size > CACHE_LIMIT) {
      let evicted = false;
      for (const [p, url] of [...cacheRef.current]) {
        if (!wanted.has(p) && Math.abs(p - page) > 8) {
          URL.revokeObjectURL(url);
          cacheRef.current.delete(p);
          evicted = true;
        }
      }
      if (evicted) setUrls(new Map(cacheRef.current));
    }
  }, [id, page, spreads, spreadIndex, pageNames]);

  // Release everything when the document closes.
  useEffect(() => {
    const cache = cacheRef.current;
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url);
      cache.clear();
      closeComic(id);
    };
  }, [id]);

  // Keyboard navigation. In RTL (manga) mode the left arrow advances.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const forward = direction === "ltr" ? "ArrowRight" : "ArrowLeft";
      const backward = direction === "ltr" ? "ArrowLeft" : "ArrowRight";
      switch (e.key) {
        case forward:
        case "PageDown":
        case " ":
          e.preventDefault();
          next();
          break;
        case backward:
        case "PageUp":
          e.preventDefault();
          prev();
          break;
        case "Home":
          goToPage(0);
          break;
        case "End":
          goToPage(pageCount - 1);
          break;
        case "+":
        case "=":
          zoomBy(1.1);
          break;
        case "-":
          zoomBy(1 / 1.1);
          break;
        case "0":
          setZoom(1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [direction, next, prev, goToPage, pageCount, zoomBy]);

  // Ctrl+wheel zoom needs a non-passive native listener to preventDefault.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  const ordered = direction === "rtl" ? [...visible].reverse() : visible;

  const spreadStyle: React.CSSProperties =
    fit === "height"
      ? { height: `${100 * zoom}%` }
      : { width: `${100 * zoom}%` };
  const imgStyle: React.CSSProperties =
    fit === "height"
      ? { height: "100%", width: "auto" }
      : { width: `${100 / Math.max(1, ordered.length)}%`, height: "auto" };

  const jumpToInput = () => {
    const n = parseInt(pageInput, 10);
    if (!Number.isNaN(n)) goToPage(n - 1);
    setPageInput("");
  };

  const pageLabel = visible.map((p) => p + 1).join("–");

  return (
    <div className="viewer">
      <div className="toolbar">
        <div className="toolbar-group">
          <button onClick={prev} disabled={spreadIndex === 0} title="Previous page">
            ◀
          </button>
          <input
            className="page-input"
            value={pageInput}
            placeholder={pageLabel}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && jumpToInput()}
            onBlur={() => setPageInput("")}
            title="Jump to page"
          />
          <span className="page-total">/ {pageCount}</span>
          <button
            onClick={next}
            disabled={spreadIndex >= spreads.length - 1}
            title="Next page"
          >
            ▶
          </button>
        </div>

        <div className="toolbar-group">
          <button
            className={layout === "single" ? "active" : ""}
            onClick={() => setLayout("single")}
            title="Single page"
          >
            ▯
          </button>
          <button
            className={layout === "double" ? "active" : ""}
            onClick={() => setLayout("double")}
            title="Double page"
          >
            ▯▯
          </button>
          {layout === "double" && (
            <label className="checkbox" title="Show the first page on its own">
              <input
                type="checkbox"
                checked={coverAlone}
                onChange={(e) => setCoverAlone(e.target.checked)}
              />
              Cover alone
            </label>
          )}
        </div>

        <div className="toolbar-group">
          <button
            className={fit === "width" ? "active" : ""}
            onClick={() => {
              setFit("width");
              setZoom(1);
            }}
            title="Fit to window width"
          >
            ↔ Fit width
          </button>
          <button
            className={fit === "height" ? "active" : ""}
            onClick={() => {
              setFit("height");
              setZoom(1);
            }}
            title="Fit to window height"
          >
            ↕ Fit height
          </button>
        </div>

        <div className="toolbar-group">
          <button onClick={() => zoomBy(1 / 1.1)} title="Zoom out (-)">
            −
          </button>
          <button
            className="zoom-label"
            onClick={() => setZoom(1)}
            title="Reset zoom (0)"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => zoomBy(1.1)} title="Zoom in (+)">
            +
          </button>
        </div>

        <div className="toolbar-group">
          <button
            onClick={() => setDirection(direction === "ltr" ? "rtl" : "ltr")}
            title="Toggle reading direction (manga mode)"
          >
            {direction === "ltr" ? "→ Left to right" : "← Right to left"}
          </button>
        </div>
      </div>

      <div className={`comic-stage fit-${fit}`} ref={stageRef}>
        <div className="spread" style={spreadStyle}>
          {ordered.map((p) =>
            urls.get(p) ? (
              <img
                key={p}
                src={urls.get(p)}
                style={imgStyle}
                alt={`Page ${p + 1}`}
                draggable={false}
              />
            ) : (
              <div key={p} className="page-loading" style={imgStyle}>
                Loading page {p + 1}…
              </div>
            ),
          )}
        </div>
      </div>
    </div>
  );
}
