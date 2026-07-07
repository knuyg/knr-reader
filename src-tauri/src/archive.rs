use std::fs::File;
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use zip::ZipArchive;

/// Kind of document detected from file content (magic bytes), falling back to
/// the file extension when the content is ambiguous.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentKind {
    Pdf,
    Zip,
    Rar,
}

pub fn detect_kind(path: &Path) -> Result<DocumentKind, String> {
    let mut file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut magic = [0u8; 8];
    let n = file.read(&mut magic).map_err(|e| e.to_string())?;
    if let Some(kind) = sniff_magic(&magic[..n]) {
        return Ok(kind);
    }
    // Fall back to the extension for unusual containers (e.g. self-extracting
    // archives or PDFs with leading junk).
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("pdf") => Ok(DocumentKind::Pdf),
        Some("cbz") => Ok(DocumentKind::Zip),
        Some("cbr") => Ok(DocumentKind::Rar),
        _ => Err(format!(
            "Unsupported file type: {}",
            path.file_name().unwrap_or_default().to_string_lossy()
        )),
    }
}

pub fn sniff_magic(magic: &[u8]) -> Option<DocumentKind> {
    if magic.starts_with(b"%PDF") {
        Some(DocumentKind::Pdf)
    } else if magic.starts_with(b"PK\x03\x04") || magic.starts_with(b"PK\x05\x06") {
        Some(DocumentKind::Zip)
    } else if magic.starts_with(b"Rar!\x1a\x07") {
        Some(DocumentKind::Rar)
    } else {
        None
    }
}

const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif"];

pub fn is_image_entry(name: &str) -> bool {
    let path = Path::new(name);
    // Skip macOS resource forks and hidden files anywhere in the path.
    if path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s == "__MACOSX" || s.starts_with('.')
    }) {
        return false;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| IMAGE_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Sort archive entry names the way humans expect ("page2" before "page10").
pub fn natural_sort(names: &mut [(usize, String)]) {
    names.sort_by(|a, b| natord::compare_ignore_case(&a.1, &b.1));
}

/// An opened comic archive that can serve individual pages.
pub enum Comic {
    /// CBZ: pages are read on demand straight out of the zip (cheap random access).
    Zip {
        archive: ZipArchive<BufReader<File>>,
        /// (zip entry index, entry name), natural-sorted.
        pages: Vec<(usize, String)>,
    },
    /// CBR: RAR has no cheap random access, so pages were extracted to a
    /// temporary directory when the archive was opened and are served from disk.
    Extracted {
        _dir: tempfile::TempDir,
        /// (path on disk, original entry name), natural-sorted.
        pages: Vec<(PathBuf, String)>,
    },
}

impl Comic {
    pub fn page_names(&self) -> Vec<String> {
        match self {
            Comic::Zip { pages, .. } => pages.iter().map(|(_, n)| n.clone()).collect(),
            Comic::Extracted { pages, .. } => pages.iter().map(|(_, n)| n.clone()).collect(),
        }
    }

    pub fn page_count(&self) -> usize {
        match self {
            Comic::Zip { pages, .. } => pages.len(),
            Comic::Extracted { pages, .. } => pages.len(),
        }
    }

    pub fn read_page(&mut self, index: usize) -> Result<Vec<u8>, String> {
        match self {
            Comic::Zip { archive, pages } => {
                let (zip_index, name) = pages
                    .get(index)
                    .ok_or_else(|| format!("Page {index} out of range"))?;
                let mut entry = archive
                    .by_index(*zip_index)
                    .map_err(|e| format!("Cannot read {name}: {e}"))?;
                let mut buf = Vec::with_capacity(entry.size() as usize);
                entry
                    .read_to_end(&mut buf)
                    .map_err(|e| format!("Cannot read {name}: {e}"))?;
                Ok(buf)
            }
            Comic::Extracted { pages, .. } => {
                let (path, name) = pages
                    .get(index)
                    .ok_or_else(|| format!("Page {index} out of range"))?;
                std::fs::read(path).map_err(|e| format!("Cannot read {name}: {e}"))
            }
        }
    }
}

pub fn open_zip(path: &Path) -> Result<Comic, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let mut archive =
        ZipArchive::new(BufReader::new(file)).map_err(|e| format!("Invalid CBZ: {e}"))?;

    let mut pages: Vec<(usize, String)> = Vec::new();
    for i in 0..archive.len() {
        let entry = archive
            .by_index_raw(i)
            .map_err(|e| format!("Invalid CBZ entry: {e}"))?;
        if entry.is_file() && is_image_entry(entry.name()) {
            pages.push((i, entry.name().to_string()));
        }
    }
    if pages.is_empty() {
        return Err("No images found in this archive".into());
    }
    natural_sort(&mut pages);
    Ok(Comic::Zip { archive, pages })
}

pub fn open_rar(path: &Path) -> Result<Comic, String> {
    let dir = tempfile::Builder::new()
        .prefix("knr-reader-")
        .tempdir()
        .map_err(|e| format!("Cannot create temp dir: {e}"))?;

    let mut archive = unrar::Archive::new(path)
        .open_for_processing()
        .map_err(|e| format!("Invalid CBR: {e}"))?;

    let mut pages: Vec<(usize, String)> = Vec::new();
    let mut paths: Vec<PathBuf> = Vec::new();
    while let Some(header) = archive.read_header().map_err(|e| format!("Invalid CBR: {e}"))? {
        let name = header.entry().filename.to_string_lossy().into_owned();
        archive = if header.entry().is_file() && is_image_entry(&name) {
            let (data, next) = header
                .read()
                .map_err(|e| format!("Cannot extract {name}: {e}"))?;
            let out = dir.path().join(format!("{}", paths.len()));
            std::fs::write(&out, data).map_err(|e| format!("Cannot write temp file: {e}"))?;
            pages.push((paths.len(), name));
            paths.push(out);
            next
        } else {
            header.skip().map_err(|e| format!("Invalid CBR: {e}"))?
        };
    }
    if pages.is_empty() {
        return Err("No images found in this archive".into());
    }
    natural_sort(&mut pages);
    let pages = pages
        .into_iter()
        .map(|(i, name)| (paths[i].clone(), name))
        .collect();
    Ok(Comic::Extracted { _dir: dir, pages })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_magic_bytes() {
        assert_eq!(sniff_magic(b"%PDF-1.7"), Some(DocumentKind::Pdf));
        assert_eq!(sniff_magic(b"PK\x03\x04\x14\x00"), Some(DocumentKind::Zip));
        assert_eq!(sniff_magic(b"Rar!\x1a\x07\x01\x00"), Some(DocumentKind::Rar));
        assert_eq!(sniff_magic(b"GIF89a"), None);
        assert_eq!(sniff_magic(b""), None);
    }

    #[test]
    fn filters_image_entries() {
        assert!(is_image_entry("page001.jpg"));
        assert!(is_image_entry("Volume 1/page001.PNG"));
        assert!(is_image_entry("a.webp"));
        assert!(!is_image_entry("__MACOSX/page001.jpg"));
        assert!(!is_image_entry("vol/.hidden.png"));
        assert!(!is_image_entry("ComicInfo.xml"));
        assert!(!is_image_entry("Thumbs.db"));
        assert!(!is_image_entry("noextension"));
    }

    #[test]
    fn sorts_naturally() {
        let mut names: Vec<(usize, String)> = ["p10.jpg", "p2.jpg", "P1.jpg", "p100.jpg"]
            .iter()
            .enumerate()
            .map(|(i, n)| (i, n.to_string()))
            .collect();
        natural_sort(&mut names);
        let sorted: Vec<&str> = names.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(sorted, vec!["P1.jpg", "p2.jpg", "p10.jpg", "p100.jpg"]);
    }

    #[test]
    fn reads_pages_from_zip() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("test.cbz");
        let file = File::create(&zip_path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        // Deliberately out of order, with a non-image entry mixed in.
        for (name, contents) in [
            ("p10.png", b"ten".as_slice()),
            ("ComicInfo.xml", b"<meta/>".as_slice()),
            ("p2.png", b"two".as_slice()),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap();

        let mut comic = open_zip(&zip_path).unwrap();
        assert_eq!(comic.page_count(), 2);
        assert_eq!(comic.page_names(), vec!["p2.png", "p10.png"]);
        assert_eq!(comic.read_page(0).unwrap(), b"two");
        assert_eq!(comic.read_page(1).unwrap(), b"ten");
        assert!(comic.read_page(2).is_err());
    }
}
