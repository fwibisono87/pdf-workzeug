import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open, save } from '@tauri-apps/plugin-dialog'
import type { MergeJob, OutputPathStatus, PdfInfo } from './types'

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function pickPdfFiles(): Promise<string[]> {
  const selected = await open({
    title: 'Add PDF files',
    multiple: true,
    filters: [{ name: 'PDF files', extensions: ['pdf'] }],
  })

  if (!selected) return []
  return Array.isArray(selected) ? selected : [selected]
}

export async function pickOutputPath(defaultPath?: string): Promise<string | null> {
  return save({
    title: 'Choose where to save the merged PDF',
    defaultPath,
    filters: [{ name: 'PDF files', extensions: ['pdf'] }],
  })
}

export async function loadPdf(path: string): Promise<PdfInfo> {
  return invoke<PdfInfo>('load_pdf', { path })
}

export async function getPageThumbnail(path: string, pageIndex: number): Promise<string> {
  return invoke<string>('get_page_thumbnail', { path, pageIndex })
}

export async function mergePdfs(jobs: MergeJob[], outputPath: string): Promise<void> {
  return invoke('merge_pdfs', { jobs, outputPath })
}

export async function openFile(path: string): Promise<void> {
  return invoke('open_file', { path })
}

export async function openFolder(path: string): Promise<void> {
  return invoke('open_folder', { path })
}

export async function checkOutputPath(path: string): Promise<OutputPathStatus> {
  return invoke<OutputPathStatus>('check_output_path', { path })
}

export async function subscribeToFileDrops(
  onEvent: (event: { type: 'enter' | 'over' | 'drop' | 'leave'; paths?: string[] }) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}

  return getCurrentWindow().onDragDropEvent((event) => {
    onEvent({
      type: event.payload.type,
      paths: 'paths' in event.payload ? event.payload.paths : undefined,
    })
  })
}
