import {
  ArrowClockwise,
  ClockCounterClockwise,
  Command,
  DownloadSimple,
  Folders,
  Laptop,
  Pulse,
  TerminalWindow,
  UploadSimple,
  WifiHigh,
  WifiSlash,
} from '@phosphor-icons/react'
import {
  startTransition,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type TabKey = 'live' | 'history' | 'shell' | 'files'

type AgentStatus = 'ALIVE' | 'IDLE' | 'BUSY' | 'DEAD' | 'OFFLINE'

type AgentRecord = {
  id: string
  summary: string
  status: AgentStatus
}

type GatewayStatus = {
  connected: boolean
  server: string
  message?: string
}

type OperatorEvent = {
  type: string
  agentId: string
  payload: string
}

type HistoryEntry = {
  taskId: string
  agentId: string
  command: string
  args: string
  output: string
  executedAt: number
  completedAt: number
}

type HistoryResult = {
  requestId?: string
  agentId: string
  entries: HistoryEntry[]
}

type ShellEvent = {
  type: string
  sessionId: string
  agentId: string
  data?: string
  message?: string
}

type FileEvent = {
  type: string
  transferId: string
  agentId: string
  path?: string
  data?: string
  message?: string
  isDir?: boolean
  size?: number
  modifiedAt?: number
  totalBytes?: number
  transferredBytes?: number
}

type RemoteFileEntry = {
  name: string
  path: string
  isDir: boolean
  size: number
  modifiedAt: number
}

type DownloadRecord = {
  filename: string
  chunks: Uint8Array[]
  totalBytes: number
  transferredBytes: number
}

type UploadRecord = {
  name: string
  totalBytes: number
  transferredBytes: number
}

type LogEntry = {
  id: string
  tone: 'neutral' | 'success' | 'error' | 'muted'
  text: string
}

type WebsocketEnvelope<T = unknown> = {
  event: string
  payload: T
}

const MAX_LOG_LENGTH = 96_000

function App() {
  const gatewayUrl = getGatewayUrl()
  const historyRequestId = useId()
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const liveLogRef = useRef<HTMLPreElement | null>(null)
  const shellLogRef = useRef<HTMLPreElement | null>(null)
  const fileLogRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const activeTabRef = useRef<TabKey>('live')
  const historyAgentIdRef = useRef('')
  const fileListTransferIdRef = useRef('')
  const downloadsRef = useRef<Record<string, DownloadRecord>>({})

  const [socketConnected, setSocketConnected] = useState(false)
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>({
    connected: false,
    server: gatewayUrl,
    message: 'Connecting to gateway...',
  })
  const [statusLine, setStatusLine] = useState('Connecting to gateway...')
  const [activeTab, setActiveTab] = useState<TabKey>('live')
  const [agents, setAgents] = useState<Record<string, AgentRecord>>({})
  const [historyCache, setHistoryCache] = useState<Record<string, HistoryEntry[]>>({})
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [commandInput, setCommandInput] = useState('')
  const [liveLog, setLiveLog] = useState('Waiting for operator events...\n')
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([])
  const [historyAgentId, setHistoryAgentId] = useState('')
  const [historySelected, setHistorySelected] = useState(0)
  const [shellSessionId, setShellSessionId] = useState('')
  const [shellAgentId, setShellAgentId] = useState('')
  const [shellReady, setShellReady] = useState(false)
  const [shellInput, setShellInput] = useState('')
  const [shellOutput, setShellOutput] = useState('Shell output will appear here.\n')
  const [fileBrowserPath, setFileBrowserPath] = useState('.')
  const [fileAgentId, setFileAgentId] = useState('')
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([])
  const [fileLog, setFileLog] = useState<LogEntry[]>([
    { id: createId(), tone: 'muted', text: 'No file transfer activity yet.' },
  ])
  const [fileListTransferId, setFileListTransferId] = useState('')
  const [selectedRemoteEntry, setSelectedRemoteEntry] = useState<RemoteFileEntry | null>(null)
  const [remoteUploadTarget, setRemoteUploadTarget] = useState('.')
  const [uploads, setUploads] = useState<Record<string, UploadRecord>>({})
  const [downloads, setDownloads] = useState<Record<string, DownloadRecord>>({})

  const agentOrder = buildAgentOrder(agents, historyCache)
  const selectedAgent = selectedAgentId ? agents[selectedAgentId] : undefined
  const selectedHistory = historyEntries[historySelected] ?? null
  const liveSelectedAgentId =
    selectedAgentId && agentOrder.includes(selectedAgentId)
      ? selectedAgentId
      : (agentOrder[0] ?? '')

  useEffect(() => {
    activeTabRef.current = activeTab
  }, [activeTab])

  useEffect(() => {
    historyAgentIdRef.current = historyAgentId
  }, [historyAgentId])

  useEffect(() => {
    fileListTransferIdRef.current = fileListTransferId
  }, [fileListTransferId])

  useEffect(() => {
    downloadsRef.current = downloads
  }, [downloads])

  useEffect(() => {
    if (!selectedAgentId && agentOrder.length > 0) {
      setSelectedAgentId(agentOrder[0])
      return
    }
    if (selectedAgentId && !agentOrder.includes(selectedAgentId)) {
      setSelectedAgentId(agentOrder[0] ?? '')
    }
  }, [agentOrder, selectedAgentId])

  useEffect(() => {
    let closed = false
    let retryTimer: number | null = null

    const connect = () => {
      const socket = new WebSocket(toWebSocketUrl(gatewayUrl))
      socketRef.current = socket

      socket.addEventListener('open', () => {
        if (closed) {
          return
        }
        startTransition(() => {
          setSocketConnected(true)
          setStatusLine('Connected to websocket gateway.')
        })
      })

      socket.addEventListener('close', () => {
        if (closed) {
          return
        }
        startTransition(() => {
          setSocketConnected(false)
          setGatewayStatus((current) => ({
            ...current,
            connected: false,
            message: 'Disconnected from gateway. Reconnecting...',
          }))
          setStatusLine('Disconnected from gateway. Reconnecting...')
          setShellReady(false)
        })
        retryTimer = window.setTimeout(connect, 1000)
      })

      socket.addEventListener('error', () => {
        if (closed) {
          return
        }
        startTransition(() => {
          setSocketConnected(false)
          setStatusLine('Websocket transport error.')
        })
      })

      socket.addEventListener('message', (message) => {
        const parsed = parseEnvelope(message.data)
        if (!parsed) {
          return
        }

        if (parsed.event === 'gateway:ready') {
          const payload = parsed.payload as { server?: string }
          startTransition(() => {
            if (payload.server) {
              setGatewayStatus((current) => ({ ...current, server: payload.server || current.server }))
            }
            setStatusLine('Gateway session established.')
          })
          return
        }

        if (parsed.event === 'grpc:status') {
          const payload = parsed.payload as GatewayStatus
          startTransition(() => {
            setGatewayStatus(payload)
            setStatusLine(payload.message || 'gRPC status updated.')
          })
          return
        }

        if (parsed.event === 'gateway:error') {
          const payload = parsed.payload as { message?: string }
          const messageText = payload.message || 'Unknown gateway error'
          startTransition(() => {
            appendLiveLog(setLiveLog, `[x] ${messageText}\n`)
            appendFileLog(setFileLog, 'error', messageText)
            setStatusLine(messageText)
          })
          return
        }

        if (parsed.event === 'operator:event') {
          const event = parsed.payload as OperatorEvent
          startTransition(() => {
            applyOperatorEvent({
              event,
              setAgents,
              setHistoryCache,
              setHistoryEntries,
              setHistorySelected,
              setLiveLog,
              setStatusLine,
              activeTab: activeTabRef.current,
              historyAgentId: historyAgentIdRef.current,
            })
          })
          return
        }

        if (parsed.event === 'history:list:result') {
          const payload = parsed.payload as HistoryResult
          startTransition(() => {
            setHistoryCache((current) => ({
              ...current,
              [payload.agentId]: payload.entries,
            }))
            setHistoryAgentId(payload.agentId)
            setHistoryEntries(payload.entries)
            setHistorySelected(0)
            setStatusLine(
              payload.entries.length > 0
                ? `Loaded ${payload.entries.length} history entries for ${shortAgentId(payload.agentId)}`
                : `No saved history for ${shortAgentId(payload.agentId)}`
            )
          })
          return
        }

        if (parsed.event === 'history:list:error') {
          const payload = parsed.payload as { message?: string }
          startTransition(() => {
            setStatusLine(payload.message || 'History load failed.')
          })
          return
        }

        if (parsed.event === 'shell:event') {
          const event = parsed.payload as ShellEvent
          startTransition(() => {
            applyShellEvent(event, {
              setShellSessionId,
              setShellAgentId,
              setShellReady,
              setShellOutput,
              setShellInput,
              setStatusLine,
            })
          })
          return
        }

        if (parsed.event === 'file:event') {
          const event = parsed.payload as FileEvent
          startTransition(() => {
            applyFileEvent(event, {
              fileListTransferId: fileListTransferIdRef.current,
              setFileListTransferId,
              setFileAgentId,
              setFileBrowserPath,
              setFileEntries,
              setFileLog,
              setUploads,
              downloads: downloadsRef.current,
              setDownloads,
              setStatusLine,
              setSelectedRemoteEntry,
            })
          })
        }
      })
    }

    connect()

    return () => {
      closed = true
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [gatewayUrl])

  useEffect(() => {
    if (!liveLogRef.current) {
      return
    }
    liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight
  }, [liveLog])

  useEffect(() => {
    if (!shellLogRef.current) {
      return
    }
    shellLogRef.current.scrollTop = shellLogRef.current.scrollHeight
  }, [shellOutput])

  useEffect(() => {
    if (!fileLogRef.current) {
      return
    }
    fileLogRef.current.scrollTop = fileLogRef.current.scrollHeight
  }, [fileLog, uploads, downloads])

  useEffect(() => {
    if (activeTab !== 'history') {
      return
    }

    const agentId = liveSelectedAgentId
    if (!agentId) {
      setHistoryEntries([])
      setHistoryAgentId('')
      return
    }

    if (historyCache[agentId]) {
      setHistoryAgentId(agentId)
      setHistoryEntries(historyCache[agentId])
      setHistorySelected(0)
      return
    }

    sendEvent(socketRef.current, 'history:list', {
      requestId: `${historyRequestId}-${agentId}`,
      agentId,
      limit: 50,
    })
    setStatusLine(`Loading history for ${shortAgentId(agentId)}...`)
  }, [activeTab, historyCache, historyRequestId, liveSelectedAgentId])

  useEffect(() => {
    if (activeTab !== 'shell') {
      return
    }

    const agentId = liveSelectedAgentId
    if (!agentId) {
      setStatusLine('No agent selected for shell.')
      return
    }
    const record = agents[agentId]
    if (!record || !isAgentLive(record.status)) {
      setStatusLine('Shell requires a live selected agent.')
      return
    }
    if (shellReady && shellAgentId === agentId) {
      return
    }

    if (shellSessionId) {
      sendEvent(socketRef.current, 'shell:close', { sessionId: shellSessionId })
    }

    setShellReady(false)
    setShellAgentId(agentId)
    setShellSessionId('')
    setShellOutput('Opening shell session...\n')
    sendEvent(socketRef.current, 'shell:open', {
      agentId,
      cols: 120,
      rows: 32,
    })
    setStatusLine(`Opening shell for ${shortAgentId(agentId)}...`)
  }, [activeTab, agents, liveSelectedAgentId, shellAgentId, shellReady, shellSessionId])

  useEffect(() => {
    if (activeTab !== 'files') {
      return
    }

    const agentId = liveSelectedAgentId
    if (!agentId) {
      setStatusLine('No agent selected for files.')
      return
    }
    const record = agents[agentId]
    if (!record || !isAgentLive(record.status)) {
      setStatusLine('Files requires a live selected agent.')
      return
    }

    if (fileAgentId !== agentId) {
      setFileEntries([])
      setSelectedRemoteEntry(null)
      setFileBrowserPath('.')
      setRemoteUploadTarget('.')
      requestRemoteList(socketRef.current, agentId, '.', setFileListTransferId, setStatusLine)
      return
    }

    if (fileEntries.length === 0 && !fileListTransferId) {
      requestRemoteList(socketRef.current, agentId, fileBrowserPath, setFileListTransferId, setStatusLine)
    }
  }, [activeTab, agents, fileAgentId, fileBrowserPath, fileEntries.length, fileListTransferId, liveSelectedAgentId])

  function handleDispatchCommand() {
    const line = commandInput.trim()
    if (!line) {
      setStatusLine('Enter a command first.')
      return
    }
    if (!liveSelectedAgentId) {
      setStatusLine('No agent selected.')
      return
    }

    const [command, ...rest] = line.split(/\s+/)
    sendEvent(socketRef.current, 'command:dispatch', {
      agentId: liveSelectedAgentId,
      command,
      args: rest.join(' '),
    })

    appendLiveLog(setLiveLog, `[>] ${shortAgentId(liveSelectedAgentId)} $ ${line}\n`)
    setCommandInput('')
    setStatusLine(`Queued command for ${shortAgentId(liveSelectedAgentId)}`)
  }

  function handleSelectAgent(agentId: string) {
    setSelectedAgentId(agentId)
    if (activeTab === 'history' && historyCache[agentId]) {
      setHistoryAgentId(agentId)
      setHistoryEntries(historyCache[agentId])
      setHistorySelected(0)
    }
  }

  function handleSendShellInput() {
    if (!shellSessionId || !shellReady || !shellInput.trim()) {
      return
    }
    sendEvent(socketRef.current, 'shell:input', {
      sessionId: shellSessionId,
      data: `${shellInput}\r`,
    })
    setShellOutput((current) => trimText(`${current}> ${shellInput}\n`, MAX_LOG_LENGTH))
    setShellInput('')
  }

  function handleBrowseDirectory(path: string) {
    if (!fileAgentId) {
      return
    }
    requestRemoteList(socketRef.current, fileAgentId, path, setFileListTransferId, setStatusLine)
  }

  function handleRefreshFiles() {
    if (!fileAgentId) {
      return
    }
    requestRemoteList(socketRef.current, fileAgentId, fileBrowserPath, setFileListTransferId, setStatusLine)
  }

  function handleChooseFile() {
    fileInputRef.current?.click()
  }

  async function handleUploadSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file || !fileAgentId) {
      return
    }

    const transferId = createId()
    const remotePath = resolveRemotePath(
      fileBrowserPath,
      remoteUploadTarget.trim() || fileBrowserPath
    )

    setUploads((current) => ({
      ...current,
      [transferId]: {
        name: file.name,
        totalBytes: file.size,
        transferredBytes: 0,
      },
    }))
    appendFileLog(setFileLog, 'neutral', `Uploading ${file.name} to ${remotePath}`)

    sendEvent(socketRef.current, 'file:upload:start', {
      transferId,
      agentId: fileAgentId,
      path: remotePath,
      message: file.name,
      totalBytes: file.size,
    })

    const chunkSize = 32 * 1024
    let offset = 0
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + chunkSize)
      const bytes = new Uint8Array(await chunk.arrayBuffer())
      sendEvent(socketRef.current, 'file:upload:chunk', {
        transferId,
        agentId: fileAgentId,
        path: remotePath,
        data: bytesToBase64(bytes),
      })
      offset += bytes.length
      setUploads((current) => {
        const upload = current[transferId]
        if (!upload) {
          return current
        }
        return {
          ...current,
          [transferId]: {
            ...upload,
            transferredBytes: Math.min(offset, file.size),
          },
        }
      })
    }

    sendEvent(socketRef.current, 'file:upload:end', {
      transferId,
      agentId: fileAgentId,
      path: remotePath,
    })
    event.target.value = ''
  }

  function handleDownloadEntry() {
    if (!fileAgentId || !selectedRemoteEntry || selectedRemoteEntry.isDir) {
      return
    }

    const transferId = createId()
    setDownloads((current) => ({
      ...current,
      [transferId]: {
        filename: selectedRemoteEntry.name,
        chunks: [],
        totalBytes: selectedRemoteEntry.size,
        transferredBytes: 0,
      },
    }))
    appendFileLog(
      setFileLog,
      'neutral',
      `Downloading ${selectedRemoteEntry.path} from ${shortAgentId(fileAgentId)}`
    )
    sendEvent(socketRef.current, 'file:download', {
      transferId,
      agentId: fileAgentId,
      path: selectedRemoteEntry.path,
    })
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(245,158,11,0.14),_transparent_30%),radial-gradient(circle_at_bottom_right,_rgba(16,185,129,0.12),_transparent_32%),linear-gradient(180deg,_#09090b,_#111827_58%,_#0f172a)] text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="grid gap-3 rounded-[1.6rem] border border-white/10 bg-black/35 px-5 py-4 shadow-[0_24px_80px_rgba(0,0,0,0.45)] backdrop-blur md:grid-cols-[1.8fr_1fr]">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="inline-flex items-center gap-2 rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.28em] text-amber-200">
                <Command className="size-3.5" weight="bold" />
                C2 Web Operator
              </span>
              <StatusPill connected={socketConnected && gatewayStatus.connected} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-[0.18em] text-zinc-50 sm:text-3xl">
                gRPC Operator Console
              </h1>
              <p className="mt-1 max-w-3xl text-sm text-zinc-400">
                Browser control surface for the C2 gateway. Live command execution, saved history,
                shell access, and remote file operations from one workspace.
              </p>
            </div>
          </div>
          <div className="grid gap-2 rounded-[1.2rem] border border-white/8 bg-white/[0.04] p-4 text-sm">
            <MetricRow label="Gateway" value={gatewayUrl} />
            <MetricRow label="gRPC" value={gatewayStatus.server || 'Unavailable'} />
            <MetricRow label="Agents" value={String(agentOrder.length)} />
            <MetricRow label="Status" value={statusLine} className="text-zinc-300" />
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="rounded-[1.5rem] border border-white/10 bg-black/30 p-4 backdrop-blur">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.28em] text-zinc-500">Agents</p>
                <h2 className="mt-1 text-lg font-semibold text-zinc-50">Remote Roster</h2>
              </div>
              <Button
                size="icon-sm"
                variant="outline"
                className="border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
                onClick={() => window.location.reload()}
              >
                <ArrowClockwise className="size-4" />
              </Button>
            </div>

            <div className="space-y-2">
              {agentOrder.length === 0 ? (
                <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/[0.03] px-4 py-8 text-center text-sm text-zinc-500">
                  No agents yet. Keep the gateway open and wait for live or cached agents.
                </div>
              ) : (
                agentOrder.map((agentId) => {
                  const agent = agents[agentId] ?? {
                    id: agentId,
                    summary: 'OFFLINE',
                    status: 'OFFLINE' as AgentStatus,
                  }
                  return (
                    <button
                      key={agentId}
                      type="button"
                      onClick={() => handleSelectAgent(agentId)}
                      className={cn(
                        'w-full rounded-[1rem] border px-3 py-3 text-left transition-colors',
                        selectedAgentId === agentId
                          ? 'border-amber-400/50 bg-amber-400/12'
                          : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold tracking-[0.18em] text-zinc-100">
                          {shortAgentId(agentId)}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.24em]',
                            statusBadgeClass(agent.status)
                          )}
                        >
                          {agent.status}
                        </span>
                      </div>
                      <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{renderAgentSummary(agent)}</p>
                    </button>
                  )
                })
              )}
            </div>
          </aside>

          <section className="flex min-h-[70vh] flex-col rounded-[1.5rem] border border-white/10 bg-black/30 p-4 backdrop-blur">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-3">
              <nav className="flex flex-wrap gap-2">
                <TabButton
                  active={activeTab === 'live'}
                  icon={Pulse}
                  label="Live"
                  onClick={() => setActiveTab('live')}
                />
                <TabButton
                  active={activeTab === 'history'}
                  icon={ClockCounterClockwise}
                  label="History"
                  onClick={() => setActiveTab('history')}
                />
                <TabButton
                  active={activeTab === 'shell'}
                  icon={TerminalWindow}
                  label="Shell"
                  onClick={() => setActiveTab('shell')}
                />
                <TabButton
                  active={activeTab === 'files'}
                  icon={Folders}
                  label="Files"
                  onClick={() => setActiveTab('files')}
                />
              </nav>
              <div className="text-xs uppercase tracking-[0.24em] text-zinc-500">
                Selected {liveSelectedAgentId ? shortAgentId(liveSelectedAgentId) : 'none'}
              </div>
            </div>

            {activeTab === 'live' ? (
              <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4">
                <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <ConsolePanel title="Live Output" subtitle="Streaming operator events and command output.">
                    <pre
                      ref={liveLogRef}
                      className="h-[52vh] overflow-auto rounded-[1rem] bg-zinc-950/80 p-4 text-xs leading-6 text-emerald-100 shadow-inner"
                    >
                      {liveLog}
                    </pre>
                  </ConsolePanel>
                  <InfoRail selectedAgent={selectedAgent} gatewayStatus={gatewayStatus} />
                </div>

                <div className="grid gap-3 rounded-[1.2rem] border border-white/8 bg-white/[0.03] p-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <input
                    value={commandInput}
                    onChange={(event) => setCommandInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        handleDispatchCommand()
                      }
                    }}
                    placeholder="Type a command, e.g. whoami, ls, sysinfo"
                    className="h-11 rounded-[0.9rem] border border-white/10 bg-black/40 px-4 text-sm text-zinc-100 outline-none transition focus:border-amber-400/50"
                  />
                  <Button
                    onClick={handleDispatchCommand}
                    className="h-11 rounded-[0.9rem] bg-amber-400 px-5 text-black hover:bg-amber-300"
                  >
                    Dispatch
                  </Button>
                </div>
              </div>
            ) : null}

            {activeTab === 'history' ? (
              <div className="mt-4 grid min-h-0 flex-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                <ConsolePanel title="History List" subtitle="Saved command executions from Mongo-backed history.">
                  <div className="h-[58vh] space-y-2 overflow-auto pr-1">
                    {historyEntries.length === 0 ? (
                      <EmptyState label="No saved history for this agent." />
                    ) : (
                      historyEntries.map((entry, index) => (
                        <button
                          key={entry.taskId}
                          type="button"
                          onClick={() => setHistorySelected(index)}
                          className={cn(
                            'w-full rounded-[1rem] border px-3 py-3 text-left transition',
                            historySelected === index
                              ? 'border-emerald-400/40 bg-emerald-400/10'
                              : 'border-white/8 bg-white/[0.03] hover:bg-white/[0.06]'
                          )}
                        >
                          <div className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">
                            {formatTimestamp(entry.executedAt)}
                          </div>
                          <div className="mt-2 text-sm font-medium text-zinc-100">
                            {renderCommand(entry)}
                          </div>
                        </button>
                      ))
                    )}
                  </div>
                </ConsolePanel>
                <ConsolePanel title="History Detail" subtitle="Expanded output for the selected execution.">
                  {selectedHistory ? (
                    <div className="grid h-[58vh] gap-4 overflow-hidden">
                      <div className="grid gap-1 rounded-[1rem] border border-white/8 bg-white/[0.03] p-4 text-sm text-zinc-300">
                        <MetricRow label="Task ID" value={selectedHistory.taskId} />
                        <MetricRow label="Agent" value={shortAgentId(selectedHistory.agentId)} />
                        <MetricRow label="Executed" value={formatTimestamp(selectedHistory.executedAt)} />
                        <MetricRow label="Completed" value={formatTimestamp(selectedHistory.completedAt)} />
                        <MetricRow label="Command" value={renderCommand(selectedHistory)} />
                      </div>
                      <pre className="overflow-auto rounded-[1rem] bg-zinc-950/80 p-4 text-xs leading-6 text-emerald-100">
                        {selectedHistory.output || 'No output'}
                      </pre>
                    </div>
                  ) : (
                    <EmptyState label="Choose a saved history entry to inspect output." />
                  )}
                </ConsolePanel>
              </div>
            ) : null}

            {activeTab === 'shell' ? (
              <div className="mt-4 grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
                <ConsolePanel title="Interactive Shell" subtitle="Persistent shell session bridged through the gateway.">
                  <div className="grid h-[58vh] gap-3">
                    <pre
                      ref={shellLogRef}
                      className="overflow-auto rounded-[1rem] bg-zinc-950/80 p-4 text-xs leading-6 text-emerald-100"
                    >
                      {shellOutput}
                    </pre>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <input
                        value={shellInput}
                        onChange={(event) => setShellInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            handleSendShellInput()
                          }
                        }}
                        placeholder={shellReady ? 'Type shell input and press Enter' : 'Shell not ready'}
                        className="h-11 rounded-[0.9rem] border border-white/10 bg-black/40 px-4 text-sm text-zinc-100 outline-none transition focus:border-emerald-400/50"
                      />
                      <Button
                        onClick={handleSendShellInput}
                        disabled={!shellReady}
                        className="h-11 rounded-[0.9rem] bg-emerald-400 px-5 text-black hover:bg-emerald-300 disabled:bg-zinc-700 disabled:text-zinc-400"
                      >
                        Send
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (!shellSessionId) {
                            return
                          }
                          sendEvent(socketRef.current, 'shell:close', { sessionId: shellSessionId })
                        }}
                        className="h-11 rounded-[0.9rem] border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]"
                      >
                        Close
                      </Button>
                    </div>
                  </div>
                </ConsolePanel>
                <ConsolePanel title="Shell Session" subtitle="Status and operator hints.">
                  <div className="grid gap-3 text-sm text-zinc-300">
                    <MetricRow label="Agent" value={shellAgentId ? shortAgentId(shellAgentId) : 'None'} />
                    <MetricRow label="Session" value={shellSessionId || 'Pending'} />
                    <MetricRow label="Ready" value={shellReady ? 'Yes' : 'No'} />
                    <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-4 text-zinc-400">
                      Use this tab like the original operator shell: select a live agent, wait for the
                      session to open, then stream commands interactively.
                    </div>
                  </div>
                </ConsolePanel>
              </div>
            ) : null}

            {activeTab === 'files' ? (
              <div className="mt-4 grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
                <ConsolePanel title="Remote Browser" subtitle="Browse remote directories and select files for transfer.">
                  <div className="grid h-[58vh] grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        onClick={() => handleBrowseDirectory(parentRemotePath(fileBrowserPath))}
                        className="rounded-[0.9rem] border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]"
                      >
                        Up
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleRefreshFiles}
                        className="rounded-[0.9rem] border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06]"
                      >
                        Refresh
                      </Button>
                      <div className="rounded-[0.9rem] border border-white/10 bg-black/35 px-3 py-2 text-xs text-zinc-400">
                        {fileBrowserPath}
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <input
                        value={remoteUploadTarget}
                        onChange={(event) => setRemoteUploadTarget(event.target.value)}
                        placeholder="Remote target path or directory"
                        className="h-11 rounded-[0.9rem] border border-white/10 bg-black/40 px-4 text-sm text-zinc-100 outline-none transition focus:border-sky-400/50"
                      />
                      <Button
                        onClick={handleChooseFile}
                        className="h-11 rounded-[0.9rem] bg-sky-400 px-5 text-black hover:bg-sky-300"
                      >
                        <UploadSimple className="size-4" />
                        Upload
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handleDownloadEntry}
                        disabled={!selectedRemoteEntry || selectedRemoteEntry.isDir}
                        className="h-11 rounded-[0.9rem] border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/[0.06] disabled:text-zinc-500"
                      >
                        <DownloadSimple className="size-4" />
                        Download
                      </Button>
                    </div>
                    <div className="overflow-auto rounded-[1rem] border border-white/8 bg-zinc-950/70">
                      {fileEntries.length === 0 ? (
                        <EmptyState label="No directory entries loaded." />
                      ) : (
                        <div className="divide-y divide-white/6">
                          {sortRemoteEntries(fileEntries).map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              onClick={() => {
                                setSelectedRemoteEntry(entry)
                                if (entry.isDir) {
                                  handleBrowseDirectory(entry.path)
                                }
                              }}
                              className={cn(
                                'grid w-full grid-cols-[1fr_auto] items-center gap-4 px-4 py-3 text-left transition hover:bg-white/[0.05]',
                                selectedRemoteEntry?.path === entry.path && 'bg-white/[0.06]'
                              )}
                            >
                              <div>
                                <div className="text-sm font-medium text-zinc-100">
                                  {entry.isDir ? 'DIR' : 'FILE'} · {entry.name}
                                </div>
                                <div className="mt-1 text-xs text-zinc-500">{entry.path}</div>
                              </div>
                              <div className="text-right text-xs text-zinc-500">
                                <div>{entry.isDir ? '-' : formatBytes(entry.size)}</div>
                                <div>{entry.modifiedAt ? formatTimestamp(entry.modifiedAt) : '-'}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </ConsolePanel>

                <ConsolePanel title="Transfers" subtitle="Upload and download activity from this browser session.">
                  <div className="grid h-[58vh] grid-rows-[auto_auto_minmax(0,1fr)] gap-3">
                    <div className="grid gap-2">
                      {Object.entries(uploads).map(([id, upload]) => (
                        <ProgressRow
                          key={id}
                          label={`Upload · ${upload.name}`}
                          value={upload.transferredBytes}
                          total={upload.totalBytes}
                          tone="sky"
                        />
                      ))}
                      {Object.entries(downloads).map(([id, download]) => (
                        <ProgressRow
                          key={id}
                          label={`Download · ${download.filename}`}
                          value={download.transferredBytes}
                          total={download.totalBytes}
                          tone="emerald"
                        />
                      ))}
                      {Object.keys(uploads).length === 0 && Object.keys(downloads).length === 0 ? (
                        <div className="rounded-[1rem] border border-dashed border-white/10 bg-white/[0.03] px-4 py-5 text-sm text-zinc-500">
                          No active transfers.
                        </div>
                      ) : null}
                    </div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={handleUploadSelection}
                    />
                    <div
                      ref={fileLogRef}
                      className="overflow-auto rounded-[1rem] bg-zinc-950/80 p-4 text-sm"
                    >
                      {fileLog.map((entry) => (
                        <div
                          key={entry.id}
                          className={cn(
                            'mb-2 last:mb-0',
                            entry.tone === 'success' && 'text-emerald-300',
                            entry.tone === 'error' && 'text-rose-300',
                            entry.tone === 'muted' && 'text-zinc-500',
                            entry.tone === 'neutral' && 'text-zinc-300'
                          )}
                        >
                          {entry.text}
                        </div>
                      ))}
                    </div>
                  </div>
                </ConsolePanel>
              </div>
            ) : null}
          </section>
        </section>
      </div>
    </main>
  )
}

function TabButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean
  icon: typeof Pulse
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-4 py-2 text-xs uppercase tracking-[0.24em] transition',
        active
          ? 'border-amber-400/50 bg-amber-400/12 text-amber-100'
          : 'border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.07] hover:text-zinc-200'
      )}
    >
      <Icon className="size-4" weight={active ? 'fill' : 'regular'} />
      {label}
    </button>
  )
}

function StatusPill({ connected }: { connected: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.28em]',
        connected
          ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200'
          : 'border-rose-400/30 bg-rose-400/10 text-rose-200'
      )}
    >
      {connected ? <WifiHigh className="size-3.5" weight="bold" /> : <WifiSlash className="size-3.5" weight="bold" />}
      {connected ? 'Linked' : 'Offline'}
    </span>
  )
}

function ConsolePanel({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle: string
  children: ReactNode
}) {
  return (
    <section className="rounded-[1.2rem] border border-white/8 bg-white/[0.03] p-4">
      <div className="mb-4">
        <p className="text-xs uppercase tracking-[0.24em] text-zinc-500">{title}</p>
        <h3 className="mt-1 text-lg font-semibold text-zinc-100">{subtitle}</h3>
      </div>
      {children}
    </section>
  )
}

function MetricRow({
  label,
  value,
  className,
}: {
  label: string
  value: string
  className?: string
}) {
  return (
    <div className="grid gap-1">
      <span className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">{label}</span>
      <span className={cn('break-all text-sm text-zinc-200', className)}>{value}</span>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full min-h-32 items-center justify-center rounded-[1rem] border border-dashed border-white/10 bg-white/[0.03] px-4 text-center text-sm text-zinc-500">
      {label}
    </div>
  )
}

function InfoRail({
  selectedAgent,
  gatewayStatus,
}: {
  selectedAgent?: AgentRecord
  gatewayStatus: GatewayStatus
}) {
  return (
    <ConsolePanel title="Operator Context" subtitle="Selected agent and transport state.">
      <div className="grid gap-3 text-sm text-zinc-300">
        <MetricRow label="Selected Agent" value={selectedAgent ? shortAgentId(selectedAgent.id) : 'None'} />
        <MetricRow label="Summary" value={selectedAgent ? renderAgentSummary(selectedAgent) : 'No agent selected'} />
        <MetricRow label="Gateway" value={gatewayStatus.connected ? 'Connected' : 'Disconnected'} />
        <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-4 text-zinc-400">
          The live console mirrors the original operator app: select an agent from the roster,
          dispatch commands, and watch streamed output in real time.
        </div>
        <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-4">
          <div className="flex items-center gap-3 text-zinc-200">
            <Laptop className="size-5 text-amber-200" weight="duotone" />
            Browser session is isolated per websocket connection.
          </div>
        </div>
      </div>
    </ConsolePanel>
  )
}

function ProgressRow({
  label,
  value,
  total,
  tone,
}: {
  label: string
  value: number
  total: number
  tone: 'sky' | 'emerald'
}) {
  const ratio = total > 0 ? Math.min(value / total, 1) : 0

  return (
    <div className="rounded-[1rem] border border-white/8 bg-white/[0.03] p-3">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs">
        <span className="text-zinc-300">{label}</span>
        <span className="text-zinc-500">
          {formatBytes(value)} / {formatBytes(total)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/8">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            tone === 'sky' ? 'bg-sky-400' : 'bg-emerald-400'
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  )
}

function applyOperatorEvent({
  event,
  setAgents,
  setHistoryCache,
  setHistoryEntries,
  setHistorySelected,
  setLiveLog,
  setStatusLine,
  activeTab,
  historyAgentId,
}: {
  event: OperatorEvent
  setAgents: Dispatch<SetStateAction<Record<string, AgentRecord>>>
  setHistoryCache: Dispatch<SetStateAction<Record<string, HistoryEntry[]>>>
  setHistoryEntries: Dispatch<SetStateAction<HistoryEntry[]>>
  setHistorySelected: Dispatch<SetStateAction<number>>
  setLiveLog: Dispatch<SetStateAction<string>>
  setStatusLine: Dispatch<SetStateAction<string>>
  activeTab: TabKey
  historyAgentId: string
}) {
  switch (event.type) {
    case 'agent_joined':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: event.payload,
          status: (extractStatus(event.payload) || 'ALIVE') as AgentStatus,
        },
      }))
      break
    case 'agent_cached':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: event.payload,
          status: 'OFFLINE',
        },
      }))
      break
    case 'agent_dead':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: event.payload,
          status: 'DEAD',
        },
      }))
      break
    case 'agent_removed':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: current[event.agentId]?.summary || event.payload || 'OFFLINE',
          status: 'OFFLINE',
        },
      }))
      break
    case 'history_updated':
      try {
        const entry = JSON.parse(event.payload) as HistoryEntry
        setHistoryCache((current) => {
          const existing = current[event.agentId] ?? []
          const merged = [entry, ...existing.filter((item) => item.taskId !== entry.taskId)].slice(0, 200)
          return { ...current, [event.agentId]: merged }
        })
        if (activeTab === 'history' && historyAgentId === event.agentId) {
          setHistoryEntries((current) => [entry, ...current.filter((item) => item.taskId !== entry.taskId)].slice(0, 200))
          setHistorySelected(0)
        }
      } catch {
        // Ignore malformed history payloads from the gateway.
      }
      break
    default:
      break
  }

  appendLiveLog(setLiveLog, formatOperatorEvent(event))
  if (event.type !== 'output') {
    setStatusLine(event.payload || event.type)
  }
}

function applyShellEvent(
  event: ShellEvent,
  handlers: {
    setShellSessionId: Dispatch<SetStateAction<string>>
    setShellAgentId: Dispatch<SetStateAction<string>>
    setShellReady: Dispatch<SetStateAction<boolean>>
    setShellOutput: Dispatch<SetStateAction<string>>
    setShellInput: Dispatch<SetStateAction<string>>
    setStatusLine: Dispatch<SetStateAction<string>>
  }
) {
  switch (event.type) {
    case 'open_ok':
      handlers.setShellSessionId(event.sessionId)
      handlers.setShellAgentId(event.agentId)
      handlers.setShellReady(true)
      handlers.setShellOutput('Shell connected.\n')
      handlers.setStatusLine(`Shell connected to ${shortAgentId(event.agentId)}`)
      break
    case 'open_error':
      handlers.setShellReady(false)
      handlers.setShellSessionId('')
      handlers.setStatusLine(event.message || 'Shell open error')
      break
    case 'output':
      handlers.setShellOutput((current) => trimText(current + sanitizeTerminalText(event.data || ''), MAX_LOG_LENGTH))
      break
    case 'closed':
      handlers.setShellReady(false)
      handlers.setShellSessionId('')
      handlers.setShellInput('')
      handlers.setStatusLine(event.message || 'Shell closed')
      break
    default:
      break
  }
}

function applyFileEvent(
  event: FileEvent,
  handlers: {
    fileListTransferId: string
    setFileListTransferId: Dispatch<SetStateAction<string>>
    setFileAgentId: Dispatch<SetStateAction<string>>
    setFileBrowserPath: Dispatch<SetStateAction<string>>
    setFileEntries: Dispatch<SetStateAction<RemoteFileEntry[]>>
    setFileLog: Dispatch<SetStateAction<LogEntry[]>>
    setUploads: Dispatch<SetStateAction<Record<string, UploadRecord>>>
    downloads: Record<string, DownloadRecord>
    setDownloads: Dispatch<SetStateAction<Record<string, DownloadRecord>>>
    setStatusLine: Dispatch<SetStateAction<string>>
    setSelectedRemoteEntry: Dispatch<SetStateAction<RemoteFileEntry | null>>
  }
) {
  switch (event.type) {
    case 'list_entry':
      if (event.transferId !== handlers.fileListTransferId) {
        return
      }
      handlers.setFileEntries((current) => [
        ...current,
        {
          name: event.message || pathBase(event.path || ''),
          path: event.path || '',
          isDir: Boolean(event.isDir),
          size: event.size || 0,
          modifiedAt: event.modifiedAt || 0,
        },
      ])
      break
    case 'list_done':
      if (event.transferId !== handlers.fileListTransferId) {
        return
      }
      handlers.setFileListTransferId('')
      handlers.setFileAgentId(event.agentId)
      handlers.setFileBrowserPath(event.path || '.')
      handlers.setSelectedRemoteEntry(null)
      handlers.setStatusLine(`Listed ${event.path || '.'} for ${shortAgentId(event.agentId)}`)
      break
    case 'upload_progress':
      handlers.setUploads((current) => {
        const upload = current[event.transferId]
        if (!upload) {
          return current
        }
        return {
          ...current,
          [event.transferId]: {
            ...upload,
            totalBytes: event.totalBytes || upload.totalBytes,
            transferredBytes: event.transferredBytes || upload.transferredBytes,
          },
        }
      })
      break
    case 'upload_done':
      handlers.setUploads((current) => {
        const next = { ...current }
        delete next[event.transferId]
        return next
      })
      appendFileLog(handlers.setFileLog, 'success', `Upload finished: ${event.path || event.transferId}`)
      handlers.setStatusLine('Upload completed')
      break
    case 'download_chunk':
      handlers.setDownloads((current) => {
        const record = current[event.transferId]
        if (!record) {
          return current
        }
        const nextChunk = event.data ? base64ToBytes(event.data) : new Uint8Array()
        return {
          ...current,
          [event.transferId]: {
            ...record,
            totalBytes: event.totalBytes || record.totalBytes,
            transferredBytes: event.transferredBytes || record.transferredBytes,
            chunks: [...record.chunks, nextChunk],
          },
        }
      })
      break
    case 'download_done': {
      const record = handlers.downloads[event.transferId]
      if (record) {
        triggerBrowserDownload(record)
      }
      handlers.setDownloads((current) => {
        const next = { ...current }
        delete next[event.transferId]
        return next
      })
      appendFileLog(handlers.setFileLog, 'success', `Download finished: ${event.path || event.transferId}`)
      handlers.setStatusLine('Download completed')
      break
    }
    case 'error':
      handlers.setUploads((current) => {
        const next = { ...current }
        delete next[event.transferId]
        return next
      })
      handlers.setDownloads((current) => {
        const next = { ...current }
        delete next[event.transferId]
        return next
      })
      if (event.transferId === handlers.fileListTransferId) {
        handlers.setFileListTransferId('')
      }
      appendFileLog(handlers.setFileLog, 'error', event.message || 'File transfer error')
      handlers.setStatusLine(event.message || 'File transfer error')
      break
    default:
      break
  }
}

function requestRemoteList(
  socket: WebSocket | null,
  agentId: string,
  path: string,
  setTransferId: Dispatch<SetStateAction<string>>,
  setStatusLine: Dispatch<SetStateAction<string>>
) {
  const transferId = createId()
  setTransferId(transferId)
  sendEvent(socket, 'file:list', {
    transferId,
    agentId,
    path,
  })
  setStatusLine(`Loading ${path} for ${shortAgentId(agentId)}...`)
}

function renderAgentSummary(agent: AgentRecord) {
  if (agent.status === 'OFFLINE') {
    return renderOfflineSummary(agent.summary)
  }
  return agent.summary
}

function renderOfflineSummary(summary: string) {
  const trimmed = summary.trim()
  if (!trimmed) {
    return '[OFFLINE]'
  }
  const start = trimmed.lastIndexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start !== -1 && end === trimmed.length - 1) {
    return `${trimmed.slice(0, start).trim()} [OFFLINE]`
  }
  return `${trimmed} [OFFLINE]`
}

function buildAgentOrder(
  agents: Record<string, AgentRecord>,
  historyCache: Record<string, HistoryEntry[]>
) {
  const ids = new Set<string>(Object.keys(agents))
  for (const [agentId, entries] of Object.entries(historyCache)) {
    if (entries.length > 0) {
      ids.add(agentId)
    }
  }
  return [...ids].sort((left, right) => {
    const leftStatus = agents[left]?.status || 'OFFLINE'
    const rightStatus = agents[right]?.status || 'OFFLINE'
    const rankDiff = statusRank(leftStatus) - statusRank(rightStatus)
    if (rankDiff !== 0) {
      return rankDiff
    }
    return left.localeCompare(right)
  })
}

function statusRank(status: AgentStatus) {
  switch (status) {
    case 'ALIVE':
    case 'IDLE':
    case 'BUSY':
      return 0
    case 'DEAD':
      return 1
    case 'OFFLINE':
      return 2
  }
}

function statusBadgeClass(status: AgentStatus) {
  switch (status) {
    case 'ALIVE':
      return 'bg-emerald-400/10 text-emerald-200'
    case 'IDLE':
      return 'bg-sky-400/10 text-sky-200'
    case 'BUSY':
      return 'bg-amber-400/10 text-amber-200'
    case 'DEAD':
      return 'bg-rose-400/10 text-rose-200'
    case 'OFFLINE':
      return 'bg-zinc-500/10 text-zinc-300'
  }
}

function isAgentLive(status: AgentStatus) {
  return status === 'ALIVE' || status === 'IDLE' || status === 'BUSY'
}

function shortAgentId(id: string) {
  return id.length <= 8 ? id : id.slice(0, 8)
}

function extractStatus(payload: string) {
  const start = payload.lastIndexOf('[')
  const end = payload.lastIndexOf(']')
  if (start === -1 || end === -1 || end <= start + 1) {
    return ''
  }
  return payload.slice(start + 1, end)
}

function renderCommand(entry: Pick<HistoryEntry, 'command' | 'args'>) {
  return entry.args ? `${entry.command} ${entry.args}` : entry.command
}

function appendLiveLog(
  setter: Dispatch<SetStateAction<string>>,
  chunk: string
) {
  setter((current) => trimText(current + chunk, MAX_LOG_LENGTH))
}

function appendFileLog(
  setter: Dispatch<SetStateAction<LogEntry[]>>,
  tone: LogEntry['tone'],
  text: string
) {
  setter((current) => [...current.slice(-80), { id: createId(), tone, text }])
}

function formatOperatorEvent(event: OperatorEvent) {
  switch (event.type) {
    case 'agent_joined':
      return `[+] agent:${shortAgentId(event.agentId)} ${event.payload}\n`
    case 'agent_cached':
      return `[.] agent:${shortAgentId(event.agentId)} ${event.payload}\n`
    case 'agent_removed':
      return `[-] agent:${shortAgentId(event.agentId)} ${event.payload}\n`
    case 'agent_dead':
      return `[!] agent:${shortAgentId(event.agentId)} ${event.payload}\n`
    case 'ack':
      return `[~] agent:${shortAgentId(event.agentId)} ${event.payload}\n`
    case 'error':
      return `[x] agent:${shortAgentId(event.agentId)} ${event.payload}\n`
    case 'output':
      return sanitizeTerminalText(event.payload)
    default:
      return `[?] ${event.type} ${event.payload}\n`
  }
}

function trimText(text: string, maxLength: number) {
  return text.length <= maxLength ? text : text.slice(text.length - maxLength)
}

function sanitizeTerminalText(input: string) {
  return input.replace(/\r/g, '')
}

function formatTimestamp(value: number) {
  if (!value) {
    return '-'
  }
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B'
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let index = 0
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function getGatewayUrl() {
  if (import.meta.env.VITE_GATEWAY_URL) {
    return import.meta.env.VITE_GATEWAY_URL as string
  }
  return 'http://kali.local:8080'
}

function toWebSocketUrl(url: string) {
  if (url.startsWith('https://')) {
    return `${url.replace('https://', 'wss://')}/ws`
  }
  if (url.startsWith('http://')) {
    return `${url.replace('http://', 'ws://')}/ws`
  }
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return `${url}/ws`
  }
  return `ws://${url}/ws`
}

function parseEnvelope(data: string) {
  try {
    return JSON.parse(data) as WebsocketEnvelope
  } catch {
    return null
  }
}

function sendEvent(socket: WebSocket | null, event: string, payload: unknown) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return
  }
  socket.send(JSON.stringify({ event, payload }))
}

function resolveRemotePath(base: string, target: string) {
  const trimmed = target.trim()
  if (!trimmed) {
    return base || '.'
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed
  }
  if (base === '.' || !base) {
    return trimmed
  }
  const separator = base.includes('\\') || trimmed.includes('\\') ? '\\' : '/'
  const normalized = `${base}${separator}${trimmed}`.replaceAll('\\', '/')
  const parts = normalized.split('/')
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  if (normalized.startsWith('/')) {
    return `/${stack.join('/')}`
  }
  return stack.join(separator) || '.'
}

function parentRemotePath(path: string) {
  if (!path || path === '.' || path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return path || '.'
  }
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (lastSlash <= 0) {
    return '.'
  }
  return normalized.slice(0, lastSlash)
}

function sortRemoteEntries(entries: RemoteFileEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
}

function pathBase(path: string) {
  const normalized = path.replace(/[/\\]+$/, '')
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (const value of bytes) {
    binary += String.fromCharCode(value)
  }
  return window.btoa(binary)
}

function base64ToBytes(data: string) {
  const binary = window.atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function triggerBrowserDownload(record: DownloadRecord) {
  const parts = record.chunks.map(
    (chunk) => chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer
  )
  const blob = new Blob(parts, { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = record.filename || `download-${createId()}`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export default App
