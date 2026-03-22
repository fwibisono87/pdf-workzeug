import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import clsx from 'clsx'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  FolderOpen,
  GripVertical,
  LoaderCircle,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-react'
import { useEffect, useEffectEvent, useMemo, useReducer } from 'react'
import {
  canMerge,
  createQueuedFile,
  defaultOutputPathStatus,
  getFileSummary,
  getSelectedFile,
  getTotalSelectedPages,
  initialState,
  reducer,
} from './state'
import {
  checkOutputPath,
  getPageThumbnail,
  isTauriRuntime,
  loadPdf,
  mergePdfs,
  openFile,
  openFolder,
  pickOutputPath,
  pickPdfFiles,
  subscribeToFileDrops,
} from './tauri'
import type { FileItem } from './types'

function filenameOnly(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function parentDirectory(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index > 0 ? trimmed.slice(0, index) : trimmed
}

function SortableFileRow({
  file,
  isSelected,
  canMoveUp,
  canMoveDown,
  onSelect,
  onMove,
  onRemove,
}: {
  file: FileItem
  isSelected: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onSelect: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: file.id })

  return (
    <article
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={clsx(
        'rounded-[22px] border p-4 shadow-sm transition',
        isSelected ? 'border-[var(--accent)] bg-white' : 'border-[var(--line)] bg-white/80',
        isDragging && 'opacity-80 shadow-lg',
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          aria-label={`Reorder ${file.filename}`}
          className="mt-1 rounded-full border border-transparent p-2 text-[var(--muted)] hover:border-[var(--line)] hover:bg-[var(--paper)]"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-5" />
        </button>

        <button type="button" onClick={onSelect} className="min-w-0 flex-1 text-left">
          <p className="truncate font-heading text-[1.1rem] font-semibold text-[var(--ink)]">
            {file.filename}
          </p>
          <p
            className={clsx(
              'mt-1 text-[0.96rem]',
              file.status === 'error' ? 'text-[var(--danger)]' : 'text-[var(--muted)]',
            )}
          >
            {file.status === 'error' && <TriangleAlert className="mr-1 inline size-4 align-[-2px]" />}
            {getFileSummary(file)}
          </p>
        </button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" onClick={() => onMove(-1)} disabled={!canMoveUp} className="action-chip">
          <ChevronUp className="size-4" />
          Move Up
        </button>
        <button type="button" onClick={() => onMove(1)} disabled={!canMoveDown} className="action-chip">
          <ChevronDown className="size-4" />
          Move Down
        </button>
        <button type="button" onClick={onRemove} className="action-chip text-[var(--danger)]">
          <Trash2 className="size-4" />
          Remove
        </button>
      </div>
    </article>
  )
}

function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const selectedFile = getSelectedFile(state)
  const totalSelectedPages = useMemo(() => getTotalSelectedPages(state), [state])
  const mergeDisabled = !canMerge(state)
  const isTauri = isTauriRuntime()

  const queuePaths = useEffectEvent(async (paths: string[]) => {
    const pdfPaths = paths.filter((path) => path.toLowerCase().endsWith('.pdf'))

    if (pdfPaths.length === 0) return

    const queuedFiles = pdfPaths.map(createQueuedFile)
    dispatch({ type: 'queueFiles', files: queuedFiles })

    await Promise.allSettled(
      queuedFiles.map(async (file) => {
        try {
          const info = await loadPdf(file.path)
          dispatch({ type: 'fileLoaded', id: file.id, info })
        } catch (error) {
          dispatch({
            type: 'fileFailed',
            id: file.id,
            message: error instanceof Error ? error.message : 'Could not read this file',
          })
        }
      }),
    )
  })

  const handleAddFiles = useEffectEvent(async () => {
    try {
      const selected = await pickPdfFiles()
      await queuePaths(selected)
    } catch (error) {
      dispatch({
        type: 'setMergeFeedback',
        feedback: {
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not open the file picker.',
        },
      })
    }
  })

  const handleChooseOutput = useEffectEvent(async () => {
    try {
      const selected = await pickOutputPath(state.outputPath || undefined)
      if (selected) {
        dispatch({ type: 'setOutputPath', outputPath: selected })
      }
    } catch (error) {
      dispatch({
        type: 'setMergeFeedback',
        feedback: {
          kind: 'error',
          message: error instanceof Error ? error.message : 'Could not choose the output file.',
        },
      })
    }
  })

  const handleMerge = useEffectEvent(async () => {
    const jobs = state.files
      .filter((file) => file.status === 'ready' && file.selectedPages.length > 0)
      .map((file) => ({
        path: file.path,
        pages: [...file.selectedPages],
      }))

    if (jobs.length === 0) return

    dispatch({
      type: 'setMergeFeedback',
      feedback: { kind: 'running', message: 'Merging your PDFs…' },
    })

    try {
      await mergePdfs(jobs, state.outputPath)
      dispatch({
        type: 'setMergeFeedback',
        feedback: {
          kind: 'success',
          message: `Saved to ${filenameOnly(state.outputPath)}`,
          outputPath: state.outputPath,
        },
      })
      dispatch({
        type: 'setOutputPathStatus',
        status: { exists: true, parentExists: true },
      })
    } catch (error) {
      dispatch({
        type: 'setMergeFeedback',
        feedback: {
          kind: 'error',
          message: error instanceof Error ? error.message : 'The PDFs could not be merged.',
        },
      })
    }
  })

  useEffect(() => {
    let cancelled = false

    if (!state.outputPath.trim()) {
      dispatch({ type: 'setOutputPathStatus', status: defaultOutputPathStatus })
      return
    }

    void (async () => {
      try {
        const status = await checkOutputPath(state.outputPath)
        if (!cancelled) {
          dispatch({ type: 'setOutputPathStatus', status })
        }
      } catch {
        if (!cancelled) {
          dispatch({ type: 'setOutputPathStatus', status: { exists: false, parentExists: false } })
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [state.outputPath])

  useEffect(() => {
    if (!selectedFile || selectedFile.status !== 'ready' || !selectedFile.pageCount) return

    let cancelled = false
    const pendingPages = Array.from({ length: selectedFile.pageCount }, (_, pageIndex) => pageIndex).filter(
      (pageIndex) => !selectedFile.thumbnails[pageIndex] || selectedFile.thumbnails[pageIndex].status === 'idle',
    )

    if (pendingPages.length === 0) return

    const loadNext = async (pageIndex: number) => {
      dispatch({
        type: 'setThumbnail',
        fileId: selectedFile.id,
        pageIndex,
        thumbnail: { status: 'loading' },
      })

      try {
        const dataUrl = await getPageThumbnail(selectedFile.path, pageIndex)
        if (!cancelled) {
          dispatch({
            type: 'setThumbnail',
            fileId: selectedFile.id,
            pageIndex,
            thumbnail: { status: 'ready', dataUrl },
          })
        }
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: 'setThumbnail',
            fileId: selectedFile.id,
            pageIndex,
            thumbnail: {
              status: 'error',
              errorMessage: error instanceof Error ? error.message : 'Preview unavailable',
            },
          })
        }
      }
    }

    void (async () => {
      const queue = [...pendingPages]
      const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
        while (!cancelled) {
          const nextPage = queue.shift()
          if (nextPage === undefined) return
          await loadNext(nextPage)
        }
      })

      await Promise.all(workers)
    })()

    return () => {
      cancelled = true
    }
  }, [selectedFile?.id, selectedFile?.pageCount, selectedFile?.path, selectedFile?.status, selectedFile?.thumbnails])

  useEffect(() => {
    if (!isTauri) return

    let unlisten = () => {}

    void (async () => {
      unlisten = await subscribeToFileDrops(async (event) => {
        if (event.type === 'enter' || event.type === 'over') {
          dispatch({ type: 'setDragActive', active: true })
          return
        }

        if (event.type === 'leave') {
          dispatch({ type: 'setDragActive', active: false })
          return
        }

        dispatch({ type: 'setDragActive', active: false })

        if (event.type === 'drop' && event.paths) {
          await queuePaths(event.paths)
        }
      })
    })()

    return () => {
      unlisten()
    }
  }, [isTauri, queuePaths])

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return

    dispatch({
      type: 'reorderFiles',
      activeId: String(active.id),
      overId: String(over.id),
    })
  }

  const mergeFeedback = state.mergeFeedback

  return (
    <main className="relative min-h-screen overflow-hidden bg-[var(--bg)] text-[var(--ink)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-52 bg-[radial-gradient(circle_at_top,rgba(59,110,165,0.18),transparent_60%)]" />
      <div className="mx-auto flex min-h-screen max-w-[1500px] flex-col px-5 py-5 lg:px-8">
        <header className="rounded-[30px] border border-[var(--line)] bg-white/80 px-6 py-5 shadow-sm backdrop-blur">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="font-heading text-3xl font-semibold tracking-[-0.03em] text-[var(--ink)]">
                PDF Workzeug
              </p>
              <p className="mt-1 text-[1.02rem] text-[var(--muted)]">
                Add files, choose pages, and save one clean merged PDF.
              </p>
            </div>

            <button
              type="button"
              onClick={() => dispatch({ type: 'setHelpOpen', open: !state.helpOpen })}
              className="inline-flex min-h-12 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--paper)] px-5 text-[1rem] font-medium text-[var(--ink)] transition hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              <CircleHelp className="size-5" />
              {state.helpOpen ? 'Hide Help' : 'Help'}
            </button>
          </div>

          {state.helpOpen && (
            <section className="mt-5 grid gap-3 rounded-[24px] border border-[var(--line)] bg-[var(--paper)] p-5 lg:grid-cols-4">
              {[
                ['1', 'Add files', 'Use Add Files or drag PDFs into the window.'],
                ['2', 'Arrange them', 'Move files up, down, or drag them into order.'],
                ['3', 'Choose pages', 'Click a file, then untick any pages you do not want.'],
                ['4', 'Merge', 'Pick where to save and press the large Merge PDFs button.'],
              ].map(([step, title, body]) => (
                <article key={step} className="rounded-[20px] bg-white p-4 shadow-sm">
                  <p className="inline-flex size-10 items-center justify-center rounded-full bg-[var(--accent)] font-semibold text-white">
                    {step}
                  </p>
                  <h2 className="mt-3 font-heading text-[1.3rem] font-semibold">{title}</h2>
                  <p className="mt-2 text-[0.98rem] text-[var(--muted)]">{body}</p>
                </article>
              ))}
            </section>
          )}
        </header>

        {state.lastRemoved && (
          <section className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[var(--accent-soft)] bg-[var(--paper)] px-5 py-4 text-[1rem]">
            <p>
              Removed <span className="font-semibold">{state.lastRemoved.file.filename}</span>.
            </p>
            <button
              type="button"
              onClick={() => dispatch({ type: 'undoRemove' })}
              className="inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--accent)] px-5 font-medium text-white transition hover:brightness-110"
            >
              <Undo2 className="size-5" />
              Undo Remove
            </button>
          </section>
        )}

        {!isTauri && (
          <section className="mt-4 rounded-[22px] border border-[var(--warn-line)] bg-[var(--warn-bg)] px-5 py-4 text-[1rem] text-[var(--ink)]">
            Native file dialogs and PDF commands only work inside `tauri dev` or a packaged desktop build.
          </section>
        )}

        <section className="mt-5 grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(320px,0.95fr)_minmax(420px,1.35fr)]">
          <div className="flex min-h-[420px] flex-col rounded-[30px] border border-[var(--line)] bg-white/85 p-4 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3 px-2">
              <div>
                <h2 className="font-heading text-[1.55rem] font-semibold">Files</h2>
                <p className="text-[0.98rem] text-[var(--muted)]">Merge order follows this list from top to bottom.</p>
              </div>
              <button
                type="button"
                onClick={() => void handleAddFiles()}
                className="inline-flex min-h-12 items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-[1rem] font-medium text-white transition hover:brightness-110"
              >
                <Plus className="size-5" />
                Add Files
              </button>
            </div>

            <div
              className={clsx(
                'min-h-0 flex-1 rounded-[24px] border border-dashed p-3 transition',
                state.dragActive ? 'border-[var(--accent)] bg-[var(--paper)]' : 'border-[var(--line)] bg-[var(--panel)]',
              )}
            >
              {state.files.length === 0 ? (
                <div className="flex h-full min-h-[260px] flex-col items-center justify-center rounded-[20px] bg-white/75 px-6 text-center">
                  <p className="font-heading text-[1.6rem] font-semibold">Drop PDF files here</p>
                  <p className="mt-3 max-w-[28ch] text-[1rem] text-[var(--muted)]">
                    Or press Add Files to choose documents from your computer.
                  </p>
                </div>
              ) : (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={state.files.map((file) => file.id)} strategy={verticalListSortingStrategy}>
                    <div className="flex max-h-[60vh] flex-col gap-3 overflow-auto pr-1">
                      {state.files.map((file, index) => (
                        <SortableFileRow
                          key={file.id}
                          file={file}
                          isSelected={file.id === state.selectedFileId}
                          canMoveUp={index > 0}
                          canMoveDown={index < state.files.length - 1}
                          onSelect={() => dispatch({ type: 'selectFile', id: file.id })}
                          onMove={(direction) => dispatch({ type: 'moveFile', id: file.id, direction })}
                          onRemove={() => dispatch({ type: 'removeFile', id: file.id })}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              )}
            </div>
          </div>

          <div className="flex min-h-[420px] flex-col rounded-[30px] border border-[var(--line)] bg-white/85 p-4 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3 px-2">
              <div>
                <h2 className="font-heading text-[1.55rem] font-semibold">Pages</h2>
                <p className="text-[0.98rem] text-[var(--muted)]">
                  {selectedFile
                    ? `Choose which pages to keep from ${selectedFile.filename}.`
                    : 'Choose a file on the left to see its pages.'}
                </p>
              </div>

              {selectedFile?.status === 'ready' && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'setAllPages', fileId: selectedFile.id, selected: true })}
                    className="action-chip"
                  >
                    Select All
                  </button>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: 'setAllPages', fileId: selectedFile.id, selected: false })}
                    className="action-chip"
                  >
                    Deselect All
                  </button>
                </div>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto rounded-[24px] border border-[var(--line)] bg-[var(--panel)] p-4">
              {!selectedFile && (
                <div className="flex h-full min-h-[260px] items-center justify-center rounded-[20px] bg-white/70 px-6 text-center text-[1rem] text-[var(--muted)]">
                  Pick a PDF on the left to preview its pages.
                </div>
              )}

              {selectedFile?.status === 'loading' && (
                <div className="flex h-full min-h-[260px] items-center justify-center gap-3 rounded-[20px] bg-white/70 text-[1.02rem] text-[var(--muted)]">
                  <LoaderCircle className="size-6 animate-spin" />
                  Loading page information…
                </div>
              )}

              {selectedFile?.status === 'error' && (
                <div className="flex h-full min-h-[260px] items-center justify-center rounded-[20px] bg-white/70 px-6 text-center text-[1rem] text-[var(--danger)]">
                  {selectedFile.errorMessage ?? 'Could not read this file.'}
                </div>
              )}

              {selectedFile?.status === 'ready' && selectedFile.pageCount !== undefined && (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {Array.from({ length: selectedFile.pageCount }, (_, pageIndex) => {
                    const thumbnail = selectedFile.thumbnails[pageIndex]
                    const checked = selectedFile.selectedPages.includes(pageIndex)

                    return (
                      <label
                        key={`${selectedFile.id}-${pageIndex}`}
                        className={clsx(
                          'group block rounded-[24px] border bg-white p-3 shadow-sm transition',
                          checked ? 'border-[var(--accent)]' : 'border-[var(--line)]',
                        )}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-medium">Page {pageIndex + 1}</span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) =>
                              dispatch({
                                type: 'setPageSelected',
                                fileId: selectedFile.id,
                                pageIndex,
                                selected: event.currentTarget.checked,
                              })
                            }
                            className="size-6 accent-[var(--accent)]"
                          />
                        </div>

                        <div className="mt-3 flex aspect-[3/4] items-center justify-center overflow-hidden rounded-[18px] bg-[var(--paper)]">
                          {thumbnail?.status === 'ready' && thumbnail.dataUrl ? (
                            <img
                              src={thumbnail.dataUrl}
                              alt={`Preview of page ${pageIndex + 1}`}
                              className="h-full w-full object-contain"
                            />
                          ) : thumbnail?.status === 'error' ? (
                            <div className="px-4 text-center text-[0.95rem] text-[var(--muted)]">
                              Preview unavailable
                            </div>
                          ) : (
                            <div className="flex flex-col items-center gap-3 text-[var(--muted)]">
                              <LoaderCircle className="size-6 animate-spin" />
                              <span className="text-[0.95rem]">Loading preview…</span>
                            </div>
                          )}
                        </div>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </section>

        <footer className="mt-5 rounded-[30px] border border-[var(--line)] bg-white/90 p-5 shadow-sm backdrop-blur">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <div>
              <label htmlFor="output-path" className="block text-[1rem] font-medium text-[var(--ink)]">
                Output File
              </label>
              <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                <input
                  id="output-path"
                  value={state.outputPath}
                  onChange={(event) => dispatch({ type: 'setOutputPath', outputPath: event.currentTarget.value })}
                  placeholder="Choose where to save merged.pdf"
                  className="min-h-14 flex-1 rounded-[18px] border border-[var(--line)] bg-[var(--panel)] px-4 text-[1rem] outline-none transition focus:border-[var(--accent)]"
                />
                <button
                  type="button"
                  onClick={() => void handleChooseOutput()}
                  className="inline-flex min-h-14 items-center justify-center gap-2 rounded-[18px] border border-[var(--line)] bg-[var(--paper)] px-5 text-[1rem] font-medium text-[var(--ink)] transition hover:border-[var(--accent)]"
                >
                  <Save className="size-5" />
                  Browse
                </button>
              </div>

              {state.outputPathStatus.exists && (
                <p className="mt-3 text-[0.98rem] text-[var(--danger)]">
                  <TriangleAlert className="mr-1 inline size-4 align-[-2px]" />
                  This file already exists and will be replaced.
                </p>
              )}

              {!state.outputPathStatus.parentExists && state.outputPath.trim() && (
                <p className="mt-3 text-[0.98rem] text-[var(--danger)]">
                  Choose a save location inside an existing folder.
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={mergeDisabled}
              onClick={() => void handleMerge()}
              className={clsx(
                'inline-flex min-h-16 items-center justify-center gap-3 rounded-[22px] px-8 text-[1.08rem] font-semibold shadow-sm transition',
                mergeDisabled
                  ? 'cursor-not-allowed bg-slate-300 text-slate-600'
                  : 'bg-[var(--accent)] text-white hover:-translate-y-0.5 hover:brightness-110',
              )}
            >
              {mergeFeedback.kind === 'running' ? <LoaderCircle className="size-5 animate-spin" /> : <Check className="size-5" />}
              Merge PDFs
            </button>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[0.98rem] text-[var(--muted)]">
              {state.files.length === 0
                ? 'No files added yet.'
                : `${state.files.length} file${state.files.length === 1 ? '' : 's'} ready, ${totalSelectedPages} page${totalSelectedPages === 1 ? '' : 's'} selected.`}
            </p>

            {mergeFeedback.kind === 'running' && (
              <p className="text-[1rem] text-[var(--muted)]">{mergeFeedback.message}</p>
            )}
          </div>

          {(mergeFeedback.kind === 'success' || mergeFeedback.kind === 'error') && (
            <section
              className={clsx(
                'mt-4 flex flex-wrap items-center justify-between gap-3 rounded-[22px] px-5 py-4',
                mergeFeedback.kind === 'success'
                  ? 'border border-emerald-200 bg-emerald-50'
                  : 'border border-rose-200 bg-rose-50',
              )}
            >
              <p className="text-[1rem]">
                {mergeFeedback.kind === 'success' ? (
                  <>
                    <Check className="mr-2 inline size-5 align-[-3px] text-emerald-700" />
                    {mergeFeedback.message}
                  </>
                ) : (
                  <>
                    <TriangleAlert className="mr-2 inline size-5 align-[-3px] text-rose-700" />
                    {mergeFeedback.message}
                  </>
                )}
              </p>

              {mergeFeedback.kind === 'success' && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void openFile(mergeFeedback.outputPath)}
                    className="action-chip border-emerald-300 bg-white text-emerald-800"
                  >
                    Open File
                  </button>
                  <button
                    type="button"
                    onClick={() => void openFolder(parentDirectory(mergeFeedback.outputPath))}
                    className="action-chip border-emerald-300 bg-white text-emerald-800"
                  >
                    <FolderOpen className="size-4" />
                    Open Folder
                  </button>
                </div>
              )}
            </section>
          )}
        </footer>
      </div>
    </main>
  )
}

export default App
