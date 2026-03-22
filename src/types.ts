export interface PdfInfo {
  path: string
  filename: string
  pageCount: number
}

export interface MergeJob {
  path: string
  pages: number[]
}

export interface OutputPathStatus {
  exists: boolean
  parentExists: boolean
}

export type ThumbnailStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ThumbnailEntry {
  status: ThumbnailStatus
  dataUrl?: string
  errorMessage?: string
}

export type FileStatus = 'loading' | 'ready' | 'error'

export interface FileItem {
  id: string
  path: string
  filename: string
  pageCount?: number
  selectedPages: number[]
  status: FileStatus
  errorMessage?: string
  thumbnails: Record<number, ThumbnailEntry>
}

export interface RemovedFileSnapshot {
  file: FileItem
  index: number
}

export type MergeFeedback =
  | { kind: 'idle' }
  | { kind: 'running'; message: string }
  | { kind: 'success'; message: string; outputPath: string }
  | { kind: 'error'; message: string }

export interface AppState {
  files: FileItem[]
  selectedFileId: string | null
  dragActive: boolean
  helpOpen: boolean
  outputPath: string
  outputPathStatus: OutputPathStatus
  mergeFeedback: MergeFeedback
  lastRemoved: RemovedFileSnapshot | null
}
