import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { loadDocState, readFileBytes, saveDocState } from "../ipc";
import type { Highlight, HighlightRect, PdfDocState } from "../types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MIN_SCALE = 0.25;
const MAX_SCALE = 6;
const HIGHLIGHT_COLORS = ["#ffd54a", "#7bd88f", "#ff8fb3", "#7aa2f7"];

type FitModeKind = "fit-width" | "fit-page" | "custom";

interface Props {
  docPath: string;
}

export default function PdfViewer({ docPath }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [scale, setScale] = useState(1.25);
  const [fitMode, setFitMode] = useState<FitModeKind>("fit-width");
  const [baseSize, setBaseSize] = useState<{ w: number; h: number } | null>(null);
  const [visiblePages, setVisiblePages] = useState<ReadonlySet<number>>(new Set([1]));
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState("");
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [highlightMode, setHighlightMode] = useState(false);
  const [color, setColor] = useState(HIGHLIGHT_COLORS[0]);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const restoredPageRef = useRef<number | null>(null);

  // Load the document.
  useEffect(() => {
    let cancelled = false;
    let loadedDoc: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const bytes = await readFileBytes(docPath);
        const pdf = await pdfjs.getDocument({ data: bytes }).promise;
        if (cancelled) {
          void pdf.destroy();
          return;
        }
        loadedDoc = pdf;
        const first = await pdf.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setBaseSize({ w: vp.width, h: vp.height });
        setNumPages(pdf.numPages);
        setDoc(pdf);
      } catch (e) {
        if (!cancelled) setError(`Could not open PDF: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
      void loadedDoc?.destroy();
    };
  }, [docPath]);

  // Restore persisted state (highlights, zoom, last page).
  useEffect(() => {
    let cancelled = false;
    loadDocState<PdfDocState>(docPath).then((s) => {
      if (cancelled) return;
      if (s) {
        if (s.highlights) setHighlights(s.highlights);
        if (s.scale) setScale(s.scale);
        if (s.fitMode) setFitMode(s.fitMode);
        if (s.page) restoredPageRef.current = s.page;
      }
      setRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [docPath]);

  // Persist state (debounced).
  useEffect(() => {
    if (!restored || !doc) return;
    const state: PdfDocState = { page: currentPage, scale, fitMode, highlights };
    const t = setTimeout(() => saveDocState(docPath, state), 400);
    return () => clearTimeout(t);
  }, [restored, doc, currentPage, scale, fitMode, highlights, docPath]);

  const applyFit = useCallback(
    (mode: FitModeKind, size = baseSize) => {
      const el = containerRef.current;
      if (!el || !size) return;
      const pad = 48;
      if (mode === "fit-width") {
        setScale(Math.min(MAX_SCALE, (el.clientWidth - pad) / size.w));
      } else if (mode === "fit-page") {
        setScale(
          Math.min(
            MAX_SCALE,
            (el.clientWidth - pad) / size.w,
            (el.clientHeight - pad) / size.h,
          ),
        );
      }
      setFitMode(mode);
    },
    [baseSize],
  );

  // Apply the initial fit once the document (and any restored state) is ready.
  useEffect(() => {
    if (!doc || !baseSize || !restored) return;
    if (fitMode !== "custom") applyFit(fitMode, baseSize);
    // Jump back to the last-read page after layout settles.
    if (restoredPageRef.current && restoredPageRef.current > 1) {
      const target = restoredPageRef.current;
      restoredPageRef.current = null;
      requestAnimationFrame(() => {
        pageEls.current.get(target)?.scrollIntoView();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, baseSize, restored]);

  // Re-apply fit modes when the window is resized.
  useEffect(() => {
    if (fitMode === "custom") return;
    const onResize = () => applyFit(fitMode);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [fitMode, applyFit]);

  // Observe page wrappers to know which pages need real rendering.
  useEffect(() => {
    if (!doc) return;
    const container = containerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisiblePages((prev) => {
          const next = new Set(prev);
          for (const entry of entries) {
            const n = Number((entry.target as HTMLElement).dataset.page);
            if (entry.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      { root: container, rootMargin: "150% 0px" },
    );
    observerRef.current = observer;
    for (const el of pageEls.current.values()) observer.observe(el);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [doc, numPages]);

  const registerPageEl = useCallback((n: number, el: HTMLDivElement | null) => {
    const prev = pageEls.current.get(n);
    if (prev && observerRef.current) observerRef.current.unobserve(prev);
    if (el) {
      pageEls.current.set(n, el);
      observerRef.current?.observe(el);
    } else {
      pageEls.current.delete(n);
    }
  }, []);

  // Track the current page while scrolling.
  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const top = container.getBoundingClientRect().top;
    let best = 1;
    let bestDist = Infinity;
    for (const [n, el] of pageEls.current) {
      const r = el.getBoundingClientRect();
      const dist = Math.abs(r.top - top) - (r.top <= top ? r.height / 2 : 0);
      if (dist < bestDist) {
        bestDist = dist;
        best = n;
      }
    }
    setCurrentPage(best);
  }, []);

  const goToPage = useCallback(
    (n: number) => {
      const clamped = Math.max(1, Math.min(numPages, n));
      pageEls.current.get(clamped)?.scrollIntoView();
      setCurrentPage(clamped);
    },
    [numPages],
  );

  const zoomBy = useCallback((factor: number) => {
    setScale((s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s * factor)));
    setFitMode("custom");
  }, []);

  // Ctrl+wheel zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  // Turn the current text selection into a highlight.
  const captureSelection = useCallback(() => {
    if (!highlightMode) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const pageEl = startEl?.closest<HTMLElement>("[data-page]");
    if (!pageEl) return;
    const pageNum = Number(pageEl.dataset.page);
    const pageRect = pageEl.getBoundingClientRect();

    const rects: HighlightRect[] = [];
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 2 || r.height < 2) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (
        cx < pageRect.left ||
        cx > pageRect.right ||
        cy < pageRect.top ||
        cy > pageRect.bottom
      ) {
        continue; // selection spilled onto another page; keep it simple
      }
      rects.push({
        x: (r.left - pageRect.left) / scale,
        y: (r.top - pageRect.top) / scale,
        w: r.width / scale,
        h: r.height / scale,
      });
    }
    // The text layer often produces overlapping rects for the same run of
    // text; drop rects fully contained in another.
    const merged = rects.filter(
      (a, i) =>
        !rects.some(
          (b, j) =>
            i !== j &&
            b.x <= a.x + 0.5 &&
            b.y <= a.y + 0.5 &&
            b.x + b.w >= a.x + a.w - 0.5 &&
            b.y + b.h >= a.y + a.h - 0.5 &&
            (b.w > a.w || b.h > a.h || j < i),
        ),
    );
    if (merged.length === 0) return;
    setHighlights((prev) => [
      ...prev,
      { id: crypto.randomUUID(), page: pageNum, color, rects: merged },
    ]);
    sel.removeAllRanges();
  }, [highlightMode, scale, color]);

  const removeHighlight = useCallback((hid: string) => {
    setHighlights((prev) => prev.filter((h) => h.id !== hid));
  }, []);

  const highlightsByPage = useMemo(() => {
    const map = new Map<number, Highlight[]>();
    for (const h of highlights) {
      const list = map.get(h.page) ?? [];
      list.push(h);
      map.set(h.page, list);
    }
    return map;
  }, [highlights]);

  if (error) {
    return <div className="error-banner">{error}</div>;
  }

  const jumpToInput = () => {
    const n = parseInt(pageInput, 10);
    if (!Number.isNaN(n)) goToPage(n);
    setPageInput("");
  };

  return (
    <div className="viewer">
      <div className="toolbar">
        <div className="toolbar-group">
          <button onClick={() => goToPage(currentPage - 1)} title="Previous page">
            ◀
          </button>
          <input
            className="page-input"
            value={pageInput}
            placeholder={String(currentPage)}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && jumpToInput()}
            onBlur={() => setPageInput("")}
            title="Jump to page"
          />
          <span className="page-total">/ {numPages}</span>
          <button onClick={() => goToPage(currentPage + 1)} title="Next page">
            ▶
          </button>
        </div>

        <div className="toolbar-group">
          <button onClick={() => zoomBy(1 / 1.1)} title="Zoom out">
            −
          </button>
          <span className="zoom-label">{Math.round(scale * 100)}%</span>
          <button onClick={() => zoomBy(1.1)} title="Zoom in">
            +
          </button>
          <button
            className={fitMode === "fit-width" ? "active" : ""}
            onClick={() => applyFit("fit-width")}
            title="Fit to window width"
          >
            ↔ Fit width
          </button>
          <button
            className={fitMode === "fit-page" ? "active" : ""}
            onClick={() => applyFit("fit-page")}
            title="Fit whole page"
          >
            ▣ Fit page
          </button>
        </div>

        <div className="toolbar-group">
          <button
            className={highlightMode ? "active" : ""}
            onClick={() => setHighlightMode((v) => !v)}
            title="Highlight mode: select text to highlight it, click a highlight to remove it"
          >
            🖍 Highlight
          </button>
          {highlightMode &&
            HIGHLIGHT_COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${color === c ? "active" : ""}`}
                style={{ background: c }}
                onClick={() => setColor(c)}
                title="Highlight colour"
              />
            ))}
        </div>
      </div>

      <div
        className={`pdf-stage ${highlightMode ? "highlighting" : ""}`}
        ref={containerRef}
        onScroll={onScroll}
        onMouseUp={captureSelection}
      >
        {doc &&
          baseSize &&
          Array.from({ length: numPages }, (_, i) => i + 1).map((n) => (
            <PdfPage
              key={n}
              doc={doc}
              pageNumber={n}
              scale={scale}
              rendered={visiblePages.has(n)}
              placeholder={baseSize}
              highlights={highlightsByPage.get(n) ?? []}
              highlightMode={highlightMode}
              onRemoveHighlight={removeHighlight}
              registerEl={registerPageEl}
            />
          ))}
        {!doc && !error && <div className="page-loading">Opening PDF…</div>}
      </div>
    </div>
  );
}

interface PageProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  rendered: boolean;
  placeholder: { w: number; h: number };
  highlights: Highlight[];
  highlightMode: boolean;
  onRemoveHighlight: (id: string) => void;
  registerEl: (n: number, el: HTMLDivElement | null) => void;
}

function PdfPage({
  doc,
  pageNumber,
  scale,
  rendered,
  placeholder,
  highlights,
  highlightMode,
  onRemoveHighlight,
  registerEl,
}: PageProps) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);
  const textLayerTaskRef = useRef<pdfjs.TextLayer | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (rendered && !page) {
      doc.getPage(pageNumber).then((p) => {
        if (!cancelled) setPage(p);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [doc, pageNumber, rendered, page]);

  useEffect(() => {
    if (!rendered || !page) return;
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!canvas || !textContainer) return;

    let cancelled = false;
    const viewport = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);

    renderTaskRef.current?.cancel();
    const renderTask = page.render({
      canvasContext: canvas.getContext("2d")!,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    renderTaskRef.current = renderTask;
    renderTask.promise.catch((e: unknown) => {
      if (!(e instanceof pdfjs.RenderingCancelledException)) {
        console.error(`Failed to render page ${pageNumber}:`, e);
      }
    });

    textLayerTaskRef.current?.cancel();
    textContainer.replaceChildren();
    const textLayer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent(),
      container: textContainer,
      viewport,
    });
    textLayerTaskRef.current = textLayer;
    textLayer.render().catch((e: unknown) => {
      if (!cancelled) console.error(`Text layer failed on page ${pageNumber}:`, e);
    });

    return () => {
      cancelled = true;
      renderTask.cancel();
      textLayer.cancel();
    };
  }, [page, scale, rendered, pageNumber]);

  const width = page
    ? page.getViewport({ scale }).width
    : placeholder.w * scale;
  const height = page
    ? page.getViewport({ scale }).height
    : placeholder.h * scale;

  return (
    <div
      className="pdf-page"
      data-page={pageNumber}
      ref={(el) => registerEl(pageNumber, el)}
      style={
        {
          width,
          height,
          "--scale-factor": scale,
        } as React.CSSProperties
      }
    >
      {rendered && page && (
        <>
          <canvas ref={canvasRef} />
          <div className="highlightLayer">
            {highlights.flatMap((h) =>
              h.rects.map((r, i) => (
                <div
                  key={`${h.id}-${i}`}
                  className="highlight"
                  style={{
                    left: r.x * scale,
                    top: r.y * scale,
                    width: r.w * scale,
                    height: r.h * scale,
                    background: h.color,
                    pointerEvents: highlightMode ? "auto" : "none",
                  }}
                  title="Click to remove this highlight"
                  onClick={() => highlightMode && onRemoveHighlight(h.id)}
                />
              )),
            )}
          </div>
          <div className="textLayer" ref={textLayerRef} />
        </>
      )}
    </div>
  );
}
