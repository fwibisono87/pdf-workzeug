Place the bundled PDFium libraries in this directory.

Expected locations:

- `windows-x64/bin/pdfium.dll`
- `linux-x64/libpdfium.so`

The Tauri bundle config copies this folder into the app resources directory so the Rust backend can resolve the preview library at runtime.
