use base64::{engine::general_purpose, Engine as _};
use image::ImageFormat;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, ObjectId, Stream,
};
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    fs::File,
    io::{Cursor, Write},
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfInfo {
    path: String,
    filename: String,
    page_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergeJob {
    path: String,
    pages: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputPathStatus {
    exists: bool,
    parent_exists: bool,
}

fn filename_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.display().to_string())
}

fn validate_pdf_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);

    if path.as_os_str().is_empty() {
        return Err("Choose a PDF file first.".into());
    }

    if !path.exists() {
        return Err("This file could not be found.".into());
    }

    if !path.is_file() {
        return Err("This path is not a file.".into());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();

    if !extension.eq_ignore_ascii_case("pdf") {
        return Err("Please choose a PDF file.".into());
    }

    Ok(path)
}

fn plain_pdf_error(error: lopdf::Error) -> String {
    match error {
        lopdf::Error::Io(_) => "This PDF could not be opened.".into(),
        _ => "Could not read this PDF.".into(),
    }
}

fn load_document(path: &Path) -> Result<Document, String> {
    let document = Document::load(path).map_err(plain_pdf_error)?;

    if document.is_encrypted() {
        return Err("Password-protected PDFs are not supported yet.".into());
    }

    Ok(document)
}

fn load_pdf_metadata(path: String) -> Result<PdfInfo, String> {
    let path_buf = validate_pdf_path(&path)?;
    let document = load_document(&path_buf)?;
    let page_count = document.get_pages().len() as u32;

    Ok(PdfInfo {
        path: path_buf.to_string_lossy().into_owned(),
        filename: filename_from_path(&path_buf),
        page_count,
    })
}

fn output_path_status(path: String) -> Result<OutputPathStatus, String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Ok(OutputPathStatus {
            exists: false,
            parent_exists: false,
        });
    }

    let output_path = PathBuf::from(trimmed);
    let parent_exists = output_path.parent().map(Path::exists).unwrap_or(false);

    Ok(OutputPathStatus {
        exists: output_path.exists(),
        parent_exists,
    })
}

fn merge_documents(jobs: &[MergeJob]) -> Result<Document, String> {
    if jobs.is_empty() {
        return Err("Add at least one PDF before merging.".into());
    }

    let mut documents_pages: Vec<(ObjectId, Object)> = Vec::new();
    let mut documents_objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    let mut document = Document::with_version("1.5");
    let mut max_id = 1;

    for job in jobs {
        if job.pages.is_empty() {
            continue;
        }

        let path = validate_pdf_path(&job.path)?;
        let mut source = load_document(&path)?;
        source.renumber_objects_with(max_id);
        max_id = source.max_id + 1;

        let pages = source.get_pages();

        for page_index in &job.pages {
            let page_number = page_index + 1;
            let page_id = pages.get(&page_number).ok_or_else(|| {
                format!(
                    "Page {} could not be found in {}.",
                    page_number,
                    filename_from_path(&path)
                )
            })?;

            let page = source
                .get_object(*page_id)
                .map_err(|_| "Could not read one of the selected pages.".to_string())?
                .to_owned();

            documents_pages.push((*page_id, page));
        }

        documents_objects.extend(source.objects.into_iter());
    }

    if documents_pages.is_empty() {
        return Err("Choose at least one page to merge.".into());
    }

    let mut catalog_object: Option<(ObjectId, Object)> = None;
    let mut pages_object: Option<(ObjectId, Object)> = None;

    for (object_id, object) in documents_objects {
        match object.type_name().unwrap_or(b"") {
            b"Catalog" => {
                catalog_object = Some((
                    catalog_object.map(|(id, _)| id).unwrap_or(object_id),
                    object,
                ));
            }
            b"Pages" => {
                if let Ok(dictionary) = object.as_dict() {
                    let mut dictionary = dictionary.clone();

                    if let Some((_, ref existing)) = pages_object {
                        if let Ok(existing_dictionary) = existing.as_dict() {
                            dictionary.extend(existing_dictionary);
                        }
                    }

                    pages_object = Some((
                        pages_object.map(|(id, _)| id).unwrap_or(object_id),
                        Object::Dictionary(dictionary),
                    ));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }

    let (catalog_id, catalog_object) =
        catalog_object.ok_or_else(|| "Could not build the merged PDF.".to_string())?;
    let (pages_id, pages_object) =
        pages_object.ok_or_else(|| "Could not build the merged PDF.".to_string())?;

    for (object_id, page_object) in &documents_pages {
        if let Ok(dictionary) = page_object.as_dict() {
            let mut dictionary = dictionary.clone();
            dictionary.set("Parent", pages_id);
            document
                .objects
                .insert(*object_id, Object::Dictionary(dictionary));
        }
    }

    if let Ok(dictionary) = pages_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Count", documents_pages.len() as u32);
        dictionary.set(
            "Kids",
            documents_pages
                .iter()
                .map(|(object_id, _)| Object::Reference(*object_id))
                .collect::<Vec<_>>(),
        );
        document
            .objects
            .insert(pages_id, Object::Dictionary(dictionary));
    }

    if let Ok(dictionary) = catalog_object.as_dict() {
        let mut dictionary = dictionary.clone();
        dictionary.set("Pages", pages_id);
        dictionary.remove(b"Outlines");
        document
            .objects
            .insert(catalog_id, Object::Dictionary(dictionary));
    }

    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.len() as u32;
    document.renumber_objects();

    Ok(document)
}

fn write_document(document: &mut Document, output_path: &Path) -> Result<(), String> {
    let parent = output_path
        .parent()
        .ok_or_else(|| "Choose an output folder first.".to_string())?;

    if !parent.exists() {
        return Err("The output folder does not exist.".into());
    }

    let temp_path = parent.join(format!(
        ".pdf-workzeug-{}.pdf",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));

    let write_result = (|| -> Result<(), String> {
        let mut temp_file =
            File::create(&temp_path).map_err(|_| "Could not create the merged PDF.".to_string())?;
        document
            .save_to(&mut temp_file)
            .map_err(|_| "Could not save the merged PDF.".to_string())?;
        temp_file
            .flush()
            .map_err(|_| "Could not finish saving the merged PDF.".to_string())?;
        Ok(())
    })();

    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
        return write_result;
    }

    if output_path.exists() {
        fs::remove_file(output_path)
            .map_err(|_| "The existing output file could not be replaced.".to_string())?;
    }

    fs::rename(&temp_path, output_path)
        .map_err(|_| "The merged PDF could not be moved into place.".to_string())?;

    Ok(())
}

fn merge_pdfs_impl(jobs: Vec<MergeJob>, output_path: String) -> Result<(), String> {
    let output_path = PathBuf::from(output_path);

    if output_path.as_os_str().is_empty() {
        return Err("Choose where to save the merged PDF.".into());
    }

    let mut document = merge_documents(&jobs)?;
    write_document(&mut document, &output_path)
}

fn pdfium_library_relative_path() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "pdfium/windows-x64/bin/pdfium.dll"
    }

    #[cfg(target_os = "linux")]
    {
        "pdfium/linux-x64/libpdfium.so"
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    {
        "pdfium/pdfium"
    }
}

fn resolve_pdfium_library_path(app: &AppHandle) -> Result<PathBuf, String> {
    let relative = pdfium_library_relative_path();
    let mut candidates = Vec::new();

    if let Ok(resource_path) = app.path().resolve(relative, BaseDirectory::Resource) {
        candidates.push(resource_path);
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("resources")
                .join(relative),
        );
        candidates.push(current_dir.join("resources").join(relative));
    }

    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "PDF previews are unavailable because the PDFium library is missing.".into())
}

fn thumbnail_impl(app: AppHandle, path: String, page_index: u32) -> Result<String, String> {
    let path_buf = validate_pdf_path(&path)?;
    let library_path = resolve_pdfium_library_path(&app)?;
    let pdfium = Pdfium::new(Pdfium::bind_to_library(&library_path).map_err(|_| {
        "PDF previews are unavailable because the preview engine could not start.".to_string()
    })?);
    let document = pdfium
        .load_pdf_from_file(&path_buf, None)
        .map_err(|_| "Could not render this page preview.".to_string())?;
    let page = document
        .pages()
        .get(page_index as usize)
        .map_err(|_| "Could not find that page preview.".to_string())?;
    let image = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(180)
                .set_maximum_height(240)
                .render_form_data(true)
                .render_annotations(true),
        )
        .map_err(|_| "Could not render this page preview.".to_string())?
        .as_image();

    let mut buffer = Cursor::new(Vec::new());
    image
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|_| "Could not prepare this page preview.".to_string())?;

    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(buffer.into_inner())
    ))
}

fn open_file_impl(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);

    if !path.exists() {
        return Err("This file could not be found.".into());
    }

    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| "This file could not be opened.".to_string())
}

fn open_folder_impl(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);

    if !path.exists() || !path.is_dir() {
        return Err("This folder could not be found.".into());
    }

    app.opener()
        .open_path(path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|_| "This folder could not be opened.".to_string())
}

#[tauri::command]
async fn load_pdf(path: String) -> Result<PdfInfo, String> {
    tauri::async_runtime::spawn_blocking(move || load_pdf_metadata(path))
        .await
        .map_err(|_| "This PDF could not be loaded.".to_string())?
}

#[tauri::command]
async fn get_page_thumbnail(
    app: AppHandle,
    path: String,
    page_index: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || thumbnail_impl(app, path, page_index))
        .await
        .map_err(|_| "This page preview could not be created.".to_string())?
}

#[tauri::command]
async fn merge_pdfs(jobs: Vec<MergeJob>, output_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || merge_pdfs_impl(jobs, output_path))
        .await
        .map_err(|_| "The PDFs could not be merged.".to_string())?
}

#[tauri::command]
fn check_output_path(path: String) -> Result<OutputPathStatus, String> {
    output_path_status(path)
}

#[tauri::command]
fn open_file(app: AppHandle, path: String) -> Result<(), String> {
    open_file_impl(app, path)
}

#[tauri::command]
fn open_folder(app: AppHandle, path: String) -> Result<(), String> {
    open_folder_impl(app, path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            load_pdf,
            get_page_thumbnail,
            merge_pdfs,
            check_output_path,
            open_file,
            open_folder
        ]);

    if cfg!(debug_assertions) {
        builder = builder.plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        );
    }

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn make_pdf(path: &Path, label: &str, page_count: u32) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! {
                "F1" => font_id,
            },
        });

        let mut page_refs = Vec::new();

        for index in 0..page_count {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 24.into()]),
                    Operation::new("Td", vec![72.into(), 720.into()]),
                    Operation::new(
                        "Tj",
                        vec![Object::string_literal(format!(
                            "{label} page {}",
                            index + 1
                        ))],
                    ),
                    Operation::new("ET", vec![]),
                ],
            };

            let content_id = document.add_object(Stream::new(
                dictionary! {},
                content.encode().expect("content encoding"),
            ));
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
                "Resources" => resources_id,
                "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
            });
            page_refs.push(page_id);
        }

        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => page_refs.iter().copied().map(Object::Reference).collect::<Vec<_>>(),
                "Count" => page_refs.len() as i64,
            }),
        );

        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.save(path).expect("save test pdf");
    }

    fn make_encrypted_marker_pdf(path: &Path) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => Vec::<Object>::new(),
                "Count" => 0,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        let encrypt_id = document.add_object(dictionary! {
            "Filter" => "Standard",
            "V" => 1,
        });
        document.trailer.set("Root", catalog_id);
        document.trailer.set("Encrypt", encrypt_id);
        document.save(path).expect("save encrypted marker pdf");
    }

    #[test]
    fn readable_pdf_metadata_is_loaded() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("sample.pdf");
        make_pdf(&path, "alpha", 2);

        let info = load_pdf_metadata(path.to_string_lossy().into_owned()).expect("metadata");

        assert_eq!(info.filename, "sample.pdf");
        assert_eq!(info.page_count, 2);
    }

    #[test]
    fn corrupt_pdf_is_rejected() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("broken.pdf");
        fs::write(&path, b"not a pdf").expect("write corrupt file");

        let error =
            load_pdf_metadata(path.to_string_lossy().into_owned()).expect_err("should fail");

        assert!(error.contains("Could not read this PDF") || error.contains("could not be opened"));
    }

    #[test]
    fn password_protected_pdf_is_rejected() {
        let directory = tempdir().expect("tempdir");
        let path = directory.path().join("locked.pdf");
        make_encrypted_marker_pdf(&path);

        let error =
            load_pdf_metadata(path.to_string_lossy().into_owned()).expect_err("should fail");

        assert!(error.contains("Password-protected PDFs are not supported yet."));
    }

    #[test]
    fn selected_pages_are_merged_without_changing_sources() {
        let directory = tempdir().expect("tempdir");
        let source_a = directory.path().join("a.pdf");
        let source_b = directory.path().join("b.pdf");
        let output = directory.path().join("merged.pdf");

        make_pdf(&source_a, "alpha", 2);
        make_pdf(&source_b, "beta", 3);

        let before_a = fs::read(&source_a).expect("source a bytes");
        let before_b = fs::read(&source_b).expect("source b bytes");

        merge_pdfs_impl(
            vec![
                MergeJob {
                    path: source_a.to_string_lossy().into_owned(),
                    pages: vec![0],
                },
                MergeJob {
                    path: source_b.to_string_lossy().into_owned(),
                    pages: vec![1, 2],
                },
            ],
            output.to_string_lossy().into_owned(),
        )
        .expect("merge succeeds");

        let merged = Document::load(&output).expect("load merged");
        assert_eq!(merged.get_pages().len(), 3);
        assert_eq!(
            fs::read(&source_a).expect("source a still exists"),
            before_a
        );
        assert_eq!(
            fs::read(&source_b).expect("source b still exists"),
            before_b
        );
    }

    #[test]
    fn existing_output_is_replaced() {
        let directory = tempdir().expect("tempdir");
        let source = directory.path().join("source.pdf");
        let output = directory.path().join("merged.pdf");

        make_pdf(&source, "source", 1);
        fs::write(&output, b"old output").expect("seed existing output");

        merge_pdfs_impl(
            vec![MergeJob {
                path: source.to_string_lossy().into_owned(),
                pages: vec![0],
            }],
            output.to_string_lossy().into_owned(),
        )
        .expect("merge succeeds");

        let merged = Document::load(&output).expect("load replaced output");
        assert_eq!(merged.get_pages().len(), 1);
    }
}
