import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { canMerge, createQueuedFile, initialState, reducer } from './state'

const {
  dialogOpenMock,
  dialogSaveMock,
  invokeMock,
  onDragDropEventMock,
} = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
  dialogSaveMock: vi.fn(),
  invokeMock: vi.fn(),
  onDragDropEventMock: vi.fn(async () => () => {}),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: dialogOpenMock,
  save: dialogSaveMock,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: onDragDropEventMock,
  }),
}))

describe('app state', () => {
  it('restores a removed file with undo', () => {
    const first = { ...createQueuedFile('C:\\docs\\one.pdf'), status: 'ready' as const, pageCount: 2, selectedPages: [0, 1] }
    const second = { ...createQueuedFile('C:\\docs\\two.pdf'), status: 'ready' as const, pageCount: 1, selectedPages: [0] }

    const queued = reducer(initialState, { type: 'queueFiles', files: [first, second] })
    const removed = reducer(queued, { type: 'removeFile', id: first.id })
    const restored = reducer(removed, { type: 'undoRemove' })

    expect(restored.files.map((file) => file.filename)).toEqual(['one.pdf', 'two.pdf'])
    expect(restored.selectedFileId).toBe(first.id)
  })

  it('requires output path and selected pages before merge is enabled', () => {
    const file = { ...createQueuedFile('C:\\docs\\one.pdf'), status: 'ready' as const, pageCount: 1, selectedPages: [0] }
    const state = reducer(initialState, { type: 'queueFiles', files: [file] })

    expect(canMerge(state)).toBe(false)

    const withPath = reducer(state, { type: 'setOutputPath', outputPath: 'C:\\docs\\merged.pdf' })
    expect(canMerge(withPath)).toBe(true)
  })
})

describe('App', () => {
  beforeEach(() => {
    dialogOpenMock.mockReset()
    dialogSaveMock.mockReset()
    invokeMock.mockReset()
    onDragDropEventMock.mockClear()
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      value: {},
      configurable: true,
    })
  })

  it('loads files from the dialog and completes a merge', async () => {
    dialogOpenMock.mockResolvedValue(['C:\\docs\\alpha.pdf'])
    invokeMock.mockImplementation(async (command: string) => {
      switch (command) {
        case 'load_pdf':
          return { path: 'C:\\docs\\alpha.pdf', filename: 'alpha.pdf', pageCount: 2 }
        case 'check_output_path':
          return { exists: false, parentExists: true }
        case 'get_page_thumbnail':
          return 'data:image/png;base64,thumb'
        case 'merge_pdfs':
          return undefined
        default:
          throw new Error(`Unexpected command: ${command}`)
      }
    })

    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /add files/i }))

    await screen.findByText('alpha.pdf')
    await waitFor(() => expect(screen.getByRole('button', { name: /merge pdfs/i })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: /merge pdfs/i }))

    await screen.findByText(/saved to merged\.pdf/i)
    expect(invokeMock).toHaveBeenCalledWith('merge_pdfs', {
      jobs: [{ path: 'C:\\docs\\alpha.pdf', pages: [0, 1] }],
      outputPath: 'C:\\docs\\merged.pdf',
    })
  })

  it('toggles the inline help panel', () => {
    render(<App />)

    fireEvent.click(screen.getByRole('button', { name: /^help$/i }))
    expect(screen.getByText(/arrange them/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /hide help/i }))
    expect(screen.queryByText(/arrange them/i)).not.toBeInTheDocument()
  })
})
