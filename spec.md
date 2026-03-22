# PDF Merger — Product Spec

## Overview

A desktop application for Windows (primary) and Linux (secondary) that lets users merge multiple PDF files — or selected page ranges from them — into a single output PDF. The target user is 60+, non-technical, and expects a clean, large, forgiving UI with no learning curve.

---

## Tech Stack

- **Framework**: Tauri v2 (Rust backend + WebView frontend)
- **Frontend**: React + TypeScript + Tailwind CSS
- **PDF Processing**: `lopdf` crate (Rust)
- **Drag and Drop**: `@dnd-kit/core` (frontend)
- **Build targets**: Windows (`.msi` / `.exe` NSIS installer), Linux (`.deb`, `.AppImage`)

---

## Core Principles

1. **Large everything** — fonts, buttons, hit targets, icons. Minimum body font size 16px, primary actions at least 48px tall.
2. **No jargon** — "Add Files", "Remove", "Move Up", "Merge" — plain words only.
3. **Forgiving** — every action is undoable or reversible within the session. No destructive operation touches original files.
4. **Single window** — no modals, no settings pages, no preferences. Everything on one screen.
5. **Immediate feedback** — every interaction has a visible response within 100ms (loading state, highlight, etc.)

---

## UI Layout

### Main Window — minimum size 900×650px, resizable

```
┌─────────────────────────────────────────────────────────┐
│  [App Logo / Name]                        [?] Help       │
├──────────────────────────┬──────────────────────────────┤
│                          │                              │
│   FILE LIST PANEL        │   PAGE PREVIEW PANEL        │
│   (left, ~40% width)     │   (right, ~60% width)       │
│                          │                              │
│  ┌────────────────────┐  │  Shows thumbnails of pages  │
│  │  📄 document1.pdf  │  │  for the selected file,     │
│  │     12 pages       │  │  with checkboxes to         │
│  │  [▲] [▼] [✕]      │  │  include/exclude pages.     │
│  ├────────────────────┤  │                              │
│  │  📄 report.pdf     │  │  Pages are shown as a       │
│  │     5 pages        │  │  scrollable grid of         │
│  │  [▲] [▼] [✕]      │  │  large thumbnails.          │
│  └────────────────────┘  │                              │
│                          │  [Select All] [Deselect All] │
│  [+ Add Files]           │                              │
│                          │                              │
├──────────────────────────┴──────────────────────────────┤
│   Output: [C:\Users\...\merged.pdf        ] [Browse]     │
│                                                          │
│                    [  MERGE PDFs  ]                      │
└─────────────────────────────────────────────────────────┘
```

---

## Feature Breakdown

### 1. Adding Files

- **"Add Files" button** opens a native OS file picker, multi-select enabled, filtered to `.pdf` only.
- **Drag and drop** — user can drag one or more PDF files from Windows Explorer / file manager directly onto the file list panel or anywhere on the app window.
- Files appear in the list in the order they were added.
- Each file entry shows: PDF icon, filename, page count.
- If a file cannot be opened or is corrupt, show an inline error on that entry: `⚠ Could not read this file` — do not block other files from loading.

### 2. Reordering Files

- Each file in the list has **Move Up (▲)** and **Move Down (▼)** buttons, clearly visible.
- Files can also be **drag-reordered** within the list (mouse drag, large drag handle on the left of each row).
- The output PDF will be merged in the top-to-bottom order shown in the list.

### 3. Removing Files

- Each file has a **Remove (✕)** button.
- No confirmation dialog — just remove it immediately. If it was an accident, they can re-add it.

### 4. Page Selection (per file)

- Clicking on a file in the list selects it and populates the right panel with **page thumbnails**.
- Thumbnails should be large enough to see content — aim for ~180×240px per thumbnail at default zoom.
- Each thumbnail has a **checkbox** (large, easy to click) to include or exclude that page.
- By default, **all pages are selected** (included) when a file is added.
- **"Select All"** and **"Deselect All"** buttons at the top of the panel.
- The file entry in the left panel should show a subtle indicator if not all pages are selected, e.g. `📄 report.pdf — 3 of 5 pages`.
- Page selection order follows the visual order in the thumbnail grid (i.e., page 1 first, always — no reordering individual pages in v1).

### 5. Output File

- A text field shows the output file path, defaulting to the folder of the first added file with filename `merged.pdf`.
- A **"Browse"** button opens a native save dialog to choose location and filename.
- If the output path already exists, warn the user inline (not a blocking dialog): `⚠ This file already exists and will be replaced.`

### 6. Merging

- A large, prominent **"Merge PDFs"** button at the bottom.
- Disabled and grayed out if: no files have been added, or no pages are selected across all files.
- On click: show a progress indicator (simple spinner or progress bar). For most documents this will be near-instant, but large files may take a moment.
- On success: show a clear success state — green checkmark, message like `✓ Saved to merged.pdf`, and a **"Open File"** button that opens the output PDF in the user's default PDF viewer, and an **"Open Folder"** button.
- On failure: show a clear error message in plain English. No stack traces visible to the user.

### 7. Help

- A small `?` or `Help` button in the top-right corner.
- Opens a simple inline panel (not a new window) with a short, illustrated step-by-step guide: Add files → Arrange them → Choose pages → Click Merge.
- Large text, simple language.

---

## Visual Design Direction

The aesthetic should feel **calm, clean, and trustworthy** — like a well-made piece of office software, not a startup app. Think of something between a refined word processor and a Swiss design poster.

- **Color palette**: Off-white background (`#F5F3EF`), dark charcoal text (`#1C1C1C`), single accent color in a warm medium blue or slate (`#3B6EA5` or similar) for primary actions. Avoid pure white backgrounds — the slight warmth reduces eye strain.
- **Typography**: A clean, highly legible serif or humanist sans for headings (e.g., `Lora`, `Source Serif 4`, or `DM Sans`). Body text at 16–18px minimum.
- **Spacing**: Generous padding. Nothing cramped. Cards/panels with rounded corners (8–12px radius).
- **Icons**: Outlined, simple — `lucide-react` or similar. Large enough to be identifiable at a glance (24–28px).
- **Buttons**: Large, clear labels, high contrast. Primary button (Merge) should be visually distinct — larger than everything else on screen.
- **No dark mode required** for v1 — a clean light theme is sufficient.

---

## Rust / Backend Responsibilities

All PDF operations happen in the Rust backend via Tauri commands. The frontend never touches the file system directly.

### Tauri Commands to implement:

```rust
// Load a PDF and return metadata + page count
load_pdf(path: String) -> Result<PdfInfo, String>

// Generate thumbnail image for a single page (returns base64 PNG)
get_page_thumbnail(path: String, page_index: u32) -> Result<String, String>

// Merge selected pages from multiple files into one output file
merge_pdfs(jobs: Vec<MergeJob>, output_path: String) -> Result<(), String>

// Open a file in the OS default application
open_file(path: String) -> Result<(), String>

// Open a folder in Explorer / file manager
open_folder(path: String) -> Result<(), String>
```

### Data structures:

```rust
struct PdfInfo {
    path: String,
    filename: String,
    page_count: u32,
}

struct MergeJob {
    path: String,
    pages: Vec<u32>,  // 0-indexed page numbers to include, in order
}
```

### Notes for the implementer:

- `lopdf` handles merging well. For thumbnails, consider `pdfium-render` (requires bundling the pdfium binary) or `pdf-rs` + a rasterizer. An alternative is to shell out to `pdftoppm` if it's available, but this is not guaranteed on Windows — so bundling a rasterizer is preferred for portability.
- The merge operation should never modify or delete original source files.
- All file paths passed from frontend should be validated as existing, readable PDF files before processing.

---

## Out of Scope (v1)

- Viewing / reading PDF content
- Annotations, editing, or form filling
- Password-protected PDFs (show a clear error if encountered)
- Splitting a single PDF into multiple outputs (may be v2)
- Reordering individual pages across documents (may be v2)
- Cloud storage / sharing
- Dark mode

---

## Platform Notes

### Windows
- Primary target. Build `.msi` and NSIS `.exe` installer.
- App should work on Windows 10 and Windows 11.
- Default save path should respect `Documents` folder.
- Use native file dialogs via Tauri's dialog plugin.

### Linux
- Secondary target. Build `.deb` and `.AppImage`.
- Test on Ubuntu 22.04+ and one RPM-based distro.
- File dialogs via Tauri's dialog plugin (uses `zenity`/`kdialog` under the hood).
- Ensure the `.AppImage` is self-contained (bundle pdfium if used).

---

## Success Criteria

A non-technical user over 60 should be able to:
1. Open the app and understand what to do without reading any instructions.
2. Add 3 PDF files, remove one page from the second file, and produce a merged output — in under 2 minutes, first try.
3. Never encounter a crash, hang, or confusing error during normal use.