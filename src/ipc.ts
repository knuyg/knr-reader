import { invoke } from "@tauri-apps/api/core";
import type { DocumentInfo } from "./types";

export function openDocument(path: string): Promise<DocumentInfo> {
  return invoke("open_document", { path });
}

export function getComicPage(id: number, index: number): Promise<ArrayBuffer> {
  return invoke("get_comic_page", { id, index });
}

export function closeComic(id: number): void {
  invoke("close_comic", { id }).catch(() => {});
}

export function readFileBytes(path: string): Promise<ArrayBuffer> {
  return invoke("read_file_bytes", { path });
}

export async function loadDocState<T>(docPath: string): Promise<T | null> {
  const raw = await invoke<string | null>("load_doc_state", { docPath });
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveDocState(docPath: string, state: unknown): void {
  invoke("save_doc_state", { docPath, data: JSON.stringify(state) }).catch(
    (e) => console.error("Failed to save document state:", e),
  );
}
