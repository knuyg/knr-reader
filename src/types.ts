export type DocumentInfo =
  | { kind: "pdf" }
  | { kind: "comic"; id: number; pageCount: number; pageNames: string[] };

export type FitMode = "width" | "height";
export type Layout = "single" | "double";
export type Direction = "ltr" | "rtl";

/** Persisted per-document state for comics. */
export interface ComicDocState {
  page?: number;
  layout?: Layout;
  coverAlone?: boolean;
  fit?: FitMode;
  zoom?: number;
  direction?: Direction;
}

export interface HighlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A text highlight; rects are in CSS pixels at PDF scale 1. */
export interface Highlight {
  id: string;
  page: number; // 1-based
  color: string;
  rects: HighlightRect[];
}

/** Persisted per-document state for PDFs. */
export interface PdfDocState {
  page?: number;
  scale?: number;
  fitMode?: "fit-width" | "fit-page" | "custom";
  highlights?: Highlight[];
}
