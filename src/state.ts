import type {
  AppState,
  FileItem,
  MergeFeedback,
  OutputPathStatus,
  PdfInfo,
  ThumbnailEntry,
} from './types'

export const defaultOutputPathStatus: OutputPathStatus = {
  exists: false,
  parentExists: true,
}

export const initialState: AppState = {
  files: [],
  selectedFileId: null,
  dragActive: false,
  helpOpen: false,
  outputPath: '',
  outputPathStatus: defaultOutputPathStatus,
  mergeFeedback: { kind: 'idle' },
  lastRemoved: null,
}

export type Action =
  | { type: 'queueFiles'; files: FileItem[] }
  | { type: 'fileLoaded'; id: string; info: PdfInfo }
  | { type: 'fileFailed'; id: string; message: string }
  | { type: 'selectFile'; id: string }
  | { type: 'moveFile'; id: string; direction: -1 | 1 }
  | { type: 'reorderFiles'; activeId: string; overId: string }
  | { type: 'removeFile'; id: string }
  | { type: 'undoRemove' }
  | { type: 'setPageSelected'; fileId: string; pageIndex: number; selected: boolean }
  | { type: 'setAllPages'; fileId: string; selected: boolean }
  | { type: 'setThumbnail'; fileId: string; pageIndex: number; thumbnail: ThumbnailEntry }
  | { type: 'setOutputPath'; outputPath: string }
  | { type: 'setOutputPathStatus'; status: OutputPathStatus }
  | { type: 'setHelpOpen'; open: boolean }
  | { type: 'setDragActive'; active: boolean }
  | { type: 'setMergeFeedback'; feedback: MergeFeedback }

export function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index > 0 ? trimmed.slice(0, index) : ''
}

export function joinPath(directory: string, filename: string): string {
  if (!directory) return filename
  const separator = directory.includes('\\') ? '\\' : '/'
  return `${directory.replace(/[\\/]+$/, '')}${separator}${filename}`
}

function range(length: number): number[] {
  return Array.from({ length }, (_, index) => index)
}

function updateFile(files: FileItem[], fileId: string, updater: (file: FileItem) => FileItem): FileItem[] {
  return files.map((file) => (file.id === fileId ? updater(file) : file))
}

function deriveSelectionAfterRemoval(
  files: FileItem[],
  selectedFileId: string | null,
  removedIndex: number,
): string | null {
  if (files.length === 0) return null
  if (selectedFileId && files.some((file) => file.id === selectedFileId)) return selectedFileId
  return files[Math.max(0, removedIndex - 1)]?.id ?? files[0]?.id ?? null
}

export function getSelectedFile(state: AppState): FileItem | null {
  return state.files.find((file) => file.id === state.selectedFileId) ?? null
}

export function getReadyFiles(state: AppState): FileItem[] {
  return state.files.filter((file) => file.status === 'ready' && (file.pageCount ?? 0) > 0)
}

export function getTotalSelectedPages(state: AppState): number {
  return getReadyFiles(state).reduce((sum, file) => sum + file.selectedPages.length, 0)
}

export function getFileSummary(file: FileItem): string {
  if (file.status === 'loading') return 'Loading PDF…'
  if (file.status === 'error') return file.errorMessage ?? 'Could not read this file'
  if (!file.pageCount) return 'No pages'
  if (file.selectedPages.length === file.pageCount) {
    return `${file.pageCount} ${file.pageCount === 1 ? 'page' : 'pages'}`
  }

  return `${file.selectedPages.length} of ${file.pageCount} pages`
}

export function canMerge(state: AppState): boolean {
  return (
    state.mergeFeedback.kind !== 'running' &&
    getReadyFiles(state).length > 0 &&
    getTotalSelectedPages(state) > 0 &&
    state.outputPath.trim().length > 0 &&
    state.outputPathStatus.parentExists
  )
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'queueFiles': {
      const files = [...state.files, ...action.files]

      return {
        ...state,
        files,
        selectedFileId: state.selectedFileId ?? action.files[0]?.id ?? null,
        mergeFeedback: state.mergeFeedback.kind === 'success' ? { kind: 'idle' } : state.mergeFeedback,
      }
    }
    case 'fileLoaded': {
      const files = updateFile(state.files, action.id, (file) => ({
        ...file,
        path: action.info.path,
        filename: action.info.filename,
        pageCount: action.info.pageCount,
        selectedPages: range(action.info.pageCount),
        status: 'ready',
        errorMessage: undefined,
      }))

      const loadedFile = files.find((file) => file.id === action.id)
      const shouldDefaultOutput = state.outputPath.trim() === '' && loadedFile?.status === 'ready'

      return {
        ...state,
        files,
        outputPath: shouldDefaultOutput ? joinPath(dirname(loadedFile.path), 'merged.pdf') : state.outputPath,
      }
    }
    case 'fileFailed':
      return {
        ...state,
        files: updateFile(state.files, action.id, (file) => ({
          ...file,
          status: 'error',
          pageCount: undefined,
          selectedPages: [],
          errorMessage: action.message,
        })),
      }
    case 'selectFile':
      return {
        ...state,
        selectedFileId: action.id,
      }
    case 'moveFile': {
      const index = state.files.findIndex((file) => file.id === action.id)
      const nextIndex = index + action.direction

      if (index < 0 || nextIndex < 0 || nextIndex >= state.files.length) return state

      const files = [...state.files]
      const [item] = files.splice(index, 1)
      files.splice(nextIndex, 0, item)

      return {
        ...state,
        files,
      }
    }
    case 'reorderFiles': {
      const activeIndex = state.files.findIndex((file) => file.id === action.activeId)
      const overIndex = state.files.findIndex((file) => file.id === action.overId)

      if (activeIndex < 0 || overIndex < 0 || activeIndex === overIndex) return state

      const files = [...state.files]
      const [item] = files.splice(activeIndex, 1)
      files.splice(overIndex, 0, item)

      return {
        ...state,
        files,
      }
    }
    case 'removeFile': {
      const index = state.files.findIndex((file) => file.id === action.id)
      if (index < 0) return state

      const removed = state.files[index]
      const files = state.files.filter((file) => file.id !== action.id)

      return {
        ...state,
        files,
        selectedFileId: deriveSelectionAfterRemoval(files, state.selectedFileId === action.id ? null : state.selectedFileId, index),
        lastRemoved: { file: removed, index },
        mergeFeedback: state.mergeFeedback.kind === 'success' ? { kind: 'idle' } : state.mergeFeedback,
      }
    }
    case 'undoRemove': {
      if (!state.lastRemoved) return state

      const files = [...state.files]
      files.splice(state.lastRemoved.index, 0, state.lastRemoved.file)

      return {
        ...state,
        files,
        selectedFileId: state.lastRemoved.file.id,
        lastRemoved: null,
      }
    }
    case 'setPageSelected':
      return {
        ...state,
        files: updateFile(state.files, action.fileId, (file) => {
          const selectedPages = action.selected
            ? Array.from(new Set([...file.selectedPages, action.pageIndex])).sort((left, right) => left - right)
            : file.selectedPages.filter((pageIndex) => pageIndex !== action.pageIndex)

          return {
            ...file,
            selectedPages,
          }
        }),
        mergeFeedback: state.mergeFeedback.kind === 'success' ? { kind: 'idle' } : state.mergeFeedback,
      }
    case 'setAllPages':
      return {
        ...state,
        files: updateFile(state.files, action.fileId, (file) => ({
          ...file,
          selectedPages: action.selected ? range(file.pageCount ?? 0) : [],
        })),
        mergeFeedback: state.mergeFeedback.kind === 'success' ? { kind: 'idle' } : state.mergeFeedback,
      }
    case 'setThumbnail':
      return {
        ...state,
        files: updateFile(state.files, action.fileId, (file) => ({
          ...file,
          thumbnails: {
            ...file.thumbnails,
            [action.pageIndex]: action.thumbnail,
          },
        })),
      }
    case 'setOutputPath':
      return {
        ...state,
        outputPath: action.outputPath,
        mergeFeedback: state.mergeFeedback.kind === 'success' ? { kind: 'idle' } : state.mergeFeedback,
      }
    case 'setOutputPathStatus':
      return {
        ...state,
        outputPathStatus: action.status,
      }
    case 'setHelpOpen':
      return {
        ...state,
        helpOpen: action.open,
      }
    case 'setDragActive':
      return {
        ...state,
        dragActive: action.active,
      }
    case 'setMergeFeedback':
      return {
        ...state,
        mergeFeedback: action.feedback,
      }
    default:
      return state
  }
}

export function createQueuedFile(path: string): FileItem {
  return {
    id: crypto.randomUUID(),
    path,
    filename: basename(path),
    selectedPages: [],
    status: 'loading',
    thumbnails: {},
  }
}
