import {
  startTransition,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from 'react';

import { ConsoleLayout } from '@/components/operator/console-layout';
import type {
  AgentRecord,
  AgentStatus,
  DownloadRecord,
  FileEvent,
  GatewayStatus,
  HistoryEntry,
  HistoryResult,
  LogEntry,
  OperatorEvent,
  RemoteFileEntry,
  ShellEvent,
  TabKey,
  UploadRecord,
  WebsocketEnvelope,
} from '@/types/operator';

const MAX_LOG_LENGTH = 96_000;

function App() {
  const gatewayUrl = getGatewayUrl();
  const historyRequestId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const liveLogRef = useRef<HTMLPreElement | null>(null);
  const shellLogRef = useRef<HTMLPreElement | null>(null);
  const fileLogRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const activeTabRef = useRef<TabKey>('live');
  const historyAgentIdRef = useRef('');
  const fileListTransferIdRef = useRef('');
  const downloadsRef = useRef<Record<string, DownloadRecord>>({});

  const [socketConnected, setSocketConnected] = useState(false);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>({
    connected: false,
    server: gatewayUrl,
    message: 'Connecting to gateway...',
  });
  const [statusLine, setStatusLine] = useState('Connecting to gateway...');
  const [activeTab, setActiveTab] = useState<TabKey>('live');
  const [agents, setAgents] = useState<Record<string, AgentRecord>>({});
  const [historyCache, setHistoryCache] = useState<Record<string, HistoryEntry[]>>({});
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [commandInput, setCommandInput] = useState('');
  const [liveLog, setLiveLog] = useState('Waiting for operator events...\n');
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyAgentId, setHistoryAgentId] = useState('');
  const [historySelected, setHistorySelected] = useState(0);
  const [shellSessionId, setShellSessionId] = useState('');
  const [shellAgentId, setShellAgentId] = useState('');
  const [shellReady, setShellReady] = useState(false);
  const [shellInput, setShellInput] = useState('');
  const [shellOutput, setShellOutput] = useState('Shell output will appear here.\n');
  const [fileBrowserPath, setFileBrowserPath] = useState('.');
  const [fileAgentId, setFileAgentId] = useState('');
  const [fileEntries, setFileEntries] = useState<RemoteFileEntry[]>([]);
  const [fileLog, setFileLog] = useState<LogEntry[]>([
    { id: createId(), tone: 'muted', text: 'No file transfer activity yet.' },
  ]);
  const [fileListTransferId, setFileListTransferId] = useState('');
  const [selectedRemoteEntry, setSelectedRemoteEntry] = useState<RemoteFileEntry | null>(null);
  const [remoteUploadTarget, setRemoteUploadTarget] = useState('.');
  const [uploads, setUploads] = useState<Record<string, UploadRecord>>({});
  const [downloads, setDownloads] = useState<Record<string, DownloadRecord>>({});

  const setCurrentFileListTransferId = (value: string) => {
    fileListTransferIdRef.current = value;
    setFileListTransferId(value);
  };

  const agentOrder = buildAgentOrder(agents, historyCache);
  const selectedAgent = selectedAgentId ? agents[selectedAgentId] : undefined;
  const selectedHistory = historyEntries[historySelected] ?? null;
  const liveSelectedAgentId =
    selectedAgentId && agentOrder.includes(selectedAgentId)
      ? selectedAgentId
      : (agentOrder[0] ?? '');

  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    historyAgentIdRef.current = historyAgentId;
  }, [historyAgentId]);

  useEffect(() => {
    downloadsRef.current = downloads;
  }, [downloads]);

  useEffect(() => {
    if (!selectedAgentId && agentOrder.length > 0) {
      setSelectedAgentId(agentOrder[0]);
      return;
    }
    if (selectedAgentId && !agentOrder.includes(selectedAgentId)) {
      setSelectedAgentId(agentOrder[0] ?? '');
    }
  }, [agentOrder, selectedAgentId]);

  useEffect(() => {
    let closed = false;
    let retryTimer: number | null = null;

    const connect = () => {
      const socket = new WebSocket(toWebSocketUrl(gatewayUrl));
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (closed) {
          return;
        }
        startTransition(() => {
          setSocketConnected(true);
          setStatusLine('Connected to websocket gateway.');
        });
      });

      socket.addEventListener('close', () => {
        if (closed) {
          return;
        }
        startTransition(() => {
          setSocketConnected(false);
          setGatewayStatus((current) => ({
            ...current,
            connected: false,
            message: 'Disconnected from gateway. Reconnecting...',
          }));
          setStatusLine('Disconnected from gateway. Reconnecting...');
          setShellReady(false);
        });
        retryTimer = window.setTimeout(connect, 1000);
      });

      socket.addEventListener('error', () => {
        if (closed) {
          return;
        }
        startTransition(() => {
          setSocketConnected(false);
          setStatusLine('Websocket transport error.');
        });
      });

      socket.addEventListener('message', (message) => {
        const parsed = parseEnvelope(message.data);
        if (!parsed) {
          return;
        }

        if (parsed.event === 'gateway:ready') {
          const payload = parsed.payload as { server?: string };
          startTransition(() => {
            if (payload.server) {
              setGatewayStatus((current) => ({
                ...current,
                server: payload.server || current.server,
              }));
            }
            setStatusLine('Gateway session established.');
          });
          return;
        }

        if (parsed.event === 'grpc:status') {
          const payload = parsed.payload as GatewayStatus;
          startTransition(() => {
            setGatewayStatus(payload);
            setStatusLine(payload.message || 'gRPC status updated.');
          });
          return;
        }

        if (parsed.event === 'gateway:error') {
          const payload = parsed.payload as { message?: string };
          const messageText = payload.message || 'Unknown gateway error';
          startTransition(() => {
            appendLiveLog(setLiveLog, `[x] ${messageText}\n`);
            appendFileLog(setFileLog, 'error', messageText);
            setStatusLine(messageText);
          });
          return;
        }

        if (parsed.event === 'operator:event') {
          const event = parsed.payload as OperatorEvent;
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
            });
          });
          return;
        }

        if (parsed.event === 'history:list:result') {
          const payload = parsed.payload as HistoryResult;
          startTransition(() => {
            setHistoryCache((current) => {
              const merged = mergeHistoryEntries(current[payload.agentId] ?? [], payload.entries);
              return {
                ...current,
                [payload.agentId]: merged,
              };
            });
            setHistoryAgentId(payload.agentId);
            setHistoryEntries((current) => mergeHistoryEntries(current, payload.entries));
            setHistorySelected(0);
            setStatusLine(
              payload.entries.length > 0
                ? `Loaded ${payload.entries.length} history entries for ${shortAgentId(payload.agentId)}`
                : `No saved history for ${shortAgentId(payload.agentId)}`,
            );
          });
          return;
        }

        if (parsed.event === 'history:list:error') {
          const payload = parsed.payload as { message?: string };
          startTransition(() => {
            setStatusLine(payload.message || 'History load failed.');
          });
          return;
        }

        if (parsed.event === 'shell:event') {
          const event = parsed.payload as ShellEvent;
          startTransition(() => {
            applyShellEvent(event, {
              setShellSessionId,
              setShellAgentId,
              setShellReady,
              setShellOutput,
              setShellInput,
              setStatusLine,
            });
          });
          return;
        }

        if (parsed.event === 'file:event') {
          const event = parsed.payload as FileEvent;
          startTransition(() => {
            applyFileEvent(event, {
              fileListTransferId: fileListTransferIdRef.current,
              setFileListTransferId: setCurrentFileListTransferId,
              setFileAgentId,
              setFileBrowserPath,
              setFileEntries,
              setFileLog,
              setUploads,
              downloads: downloadsRef.current,
              setDownloads,
              setStatusLine,
              setSelectedRemoteEntry,
            });
          });
        }
      });
    };

    connect();

    return () => {
      closed = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [gatewayUrl]);

  useEffect(() => {
    if (!liveLogRef.current) {
      return;
    }
    liveLogRef.current.scrollTop = liveLogRef.current.scrollHeight;
  }, [liveLog]);

  useEffect(() => {
    if (!shellLogRef.current) {
      return;
    }
    shellLogRef.current.scrollTop = shellLogRef.current.scrollHeight;
  }, [shellOutput]);

  useEffect(() => {
    if (!fileLogRef.current) {
      return;
    }
    fileLogRef.current.scrollTop = fileLogRef.current.scrollHeight;
  }, [fileLog, uploads, downloads]);

  useEffect(() => {
    if (activeTab !== 'history') {
      return;
    }

    const agentId = liveSelectedAgentId;
    if (!agentId) {
      setHistoryEntries([]);
      setHistoryAgentId('');
      return;
    }

    if (historyCache[agentId]) {
      setHistoryAgentId(agentId);
      setHistoryEntries(historyCache[agentId]);
      setHistorySelected(0);
      return;
    }

    sendEvent(socketRef.current, 'history:list', {
      requestId: `${historyRequestId}-${agentId}`,
      agentId,
      limit: 50,
    });
    setStatusLine(`Loading history for ${shortAgentId(agentId)}...`);
  }, [activeTab, historyCache, historyRequestId, liveSelectedAgentId]);

  useEffect(() => {
    if (activeTab !== 'shell') {
      return;
    }

    const agentId = liveSelectedAgentId;
    if (!agentId) {
      setStatusLine('No agent selected for shell.');
      return;
    }
    const record = agents[agentId];
    if (!record || !isAgentLive(record.status)) {
      setStatusLine('Shell requires a live selected agent.');
      return;
    }
    if (shellReady && shellAgentId === agentId) {
      return;
    }

    if (shellSessionId) {
      sendEvent(socketRef.current, 'shell:close', { sessionId: shellSessionId });
    }

    setShellReady(false);
    setShellAgentId(agentId);
    setShellSessionId('');
    setShellOutput('Opening shell session...\n');
    sendEvent(socketRef.current, 'shell:open', {
      agentId,
      cols: 120,
      rows: 32,
    });
    setStatusLine(`Opening shell for ${shortAgentId(agentId)}...`);
  }, [activeTab, agents, liveSelectedAgentId, shellAgentId, shellReady, shellSessionId]);

  useEffect(() => {
    if (activeTab !== 'files') {
      return;
    }

    if (!socketConnected || !gatewayStatus.connected) {
      return;
    }

    const agentId = liveSelectedAgentId;
    if (!agentId) {
      setStatusLine('No agent selected for files.');
      return;
    }
    const record = agents[agentId];
    if (!record || !isAgentLive(record.status)) {
      setStatusLine('Files requires a live selected agent.');
      return;
    }

    if (fileAgentId !== agentId) {
      if (fileListTransferId) {
        return;
      }
      setFileEntries([]);
      setSelectedRemoteEntry(null);
      setFileBrowserPath('.');
      setRemoteUploadTarget('.');
      requestRemoteList(
        socketRef.current,
        agentId,
        '.',
        setCurrentFileListTransferId,
        setStatusLine,
      );
      return;
    }

    if (fileEntries.length === 0 && !fileListTransferId) {
      requestRemoteList(
        socketRef.current,
        agentId,
        fileBrowserPath,
        setCurrentFileListTransferId,
        setStatusLine,
      );
    }
  }, [
    activeTab,
    agents,
    fileAgentId,
    fileBrowserPath,
    fileEntries.length,
    fileListTransferId,
    gatewayStatus.connected,
    liveSelectedAgentId,
    socketConnected,
  ]);

  function handleDispatchCommand() {
    const line = commandInput.trim();
    if (!line) {
      setStatusLine('Enter a command first.');
      return;
    }
    if (!liveSelectedAgentId) {
      setStatusLine('No agent selected.');
      return;
    }

    const [command, ...rest] = line.split(/\s+/);
    sendEvent(socketRef.current, 'command:dispatch', {
      agentId: liveSelectedAgentId,
      command,
      args: rest.join(' '),
    });

    appendLiveLog(setLiveLog, `[>] ${shortAgentId(liveSelectedAgentId)} $ ${line}\n`);
    setCommandInput('');
    setStatusLine(`Queued command for ${shortAgentId(liveSelectedAgentId)}`);
  }

  function handleSelectAgent(agentId: string) {
    setSelectedAgentId(agentId);
    if (activeTab === 'history' && historyCache[agentId]) {
      setHistoryAgentId(agentId);
      setHistoryEntries(historyCache[agentId]);
      setHistorySelected(0);
    }
  }

  function handleSendShellInput() {
    if (!shellSessionId || !shellReady || !shellInput.trim()) {
      return;
    }
    sendEvent(socketRef.current, 'shell:input', {
      sessionId: shellSessionId,
      data: `${shellInput}\r`,
    });
    setShellOutput((current) => trimText(`${current}> ${shellInput}\n`, MAX_LOG_LENGTH));
    setShellInput('');
  }

  function handleBrowseDirectory(path: string) {
    const targetAgentId = fileAgentId || liveSelectedAgentId;
    if (!targetAgentId) {
      return;
    }
    setFileBrowserPath(path);
    setFileEntries([]);
    setSelectedRemoteEntry(null);
    requestRemoteList(
      socketRef.current,
      targetAgentId,
      path,
      setCurrentFileListTransferId,
      setStatusLine,
    );
  }

  function handleRefreshFiles() {
    const targetAgentId = fileAgentId || liveSelectedAgentId;
    if (!targetAgentId) {
      return;
    }
    setFileEntries([]);
    setSelectedRemoteEntry(null);
    requestRemoteList(
      socketRef.current,
      targetAgentId,
      fileBrowserPath,
      setCurrentFileListTransferId,
      setStatusLine,
    );
  }

  function handleChooseFile() {
    fileInputRef.current?.click();
  }

  async function handleUploadSelection(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    const targetAgentId = fileAgentId || liveSelectedAgentId;
    if (!file || !targetAgentId) {
      return;
    }

    const transferId = createId();
    const remotePath = resolveRemotePath(
      fileBrowserPath,
      remoteUploadTarget.trim() || fileBrowserPath,
    );

    setUploads((current) => ({
      ...current,
      [transferId]: {
        name: file.name,
        totalBytes: file.size,
        transferredBytes: 0,
      },
    }));
    appendFileLog(setFileLog, 'neutral', `Uploading ${file.name} to ${remotePath}`);

    sendEvent(socketRef.current, 'file:upload:start', {
      transferId,
      agentId: targetAgentId,
      path: remotePath,
      message: file.name,
      totalBytes: file.size,
    });

    const chunkSize = 32 * 1024;
    let offset = 0;
    while (offset < file.size) {
      const chunk = file.slice(offset, offset + chunkSize);
      const bytes = new Uint8Array(await chunk.arrayBuffer());
      sendEvent(socketRef.current, 'file:upload:chunk', {
        transferId,
        agentId: targetAgentId,
        path: remotePath,
        data: bytesToBase64(bytes),
      });
      offset += bytes.length;
      setUploads((current) => {
        const upload = current[transferId];
        if (!upload) {
          return current;
        }
        return {
          ...current,
          [transferId]: {
            ...upload,
            transferredBytes: Math.min(offset, file.size),
          },
        };
      });
    }

    sendEvent(socketRef.current, 'file:upload:end', {
      transferId,
      agentId: targetAgentId,
      path: remotePath,
    });
    event.target.value = '';
  }

  function handleDownloadEntry() {
    const targetAgentId = fileAgentId || liveSelectedAgentId;
    if (!targetAgentId || !selectedRemoteEntry || selectedRemoteEntry.isDir) {
      return;
    }

    const transferId = createId();
    setDownloads((current) => ({
      ...current,
      [transferId]: {
        filename: selectedRemoteEntry.name,
        chunks: [],
        totalBytes: selectedRemoteEntry.size,
        transferredBytes: 0,
      },
    }));
    appendFileLog(
      setFileLog,
      'neutral',
      `Downloading ${selectedRemoteEntry.path} from ${shortAgentId(targetAgentId)}`,
    );
    sendEvent(socketRef.current, 'file:download', {
      transferId,
      agentId: targetAgentId,
      path: selectedRemoteEntry.path,
    });
  }

  return (
    <ConsoleLayout
      gatewayUrl={gatewayUrl}
      gatewayStatus={gatewayStatus}
      socketConnected={socketConnected}
      statusLine={statusLine}
      activeTab={activeTab}
      selectedAgentId={selectedAgentId}
      selectedAgent={selectedAgent}
      agentOrder={agentOrder}
      agents={agents}
      commandInput={commandInput}
      liveLog={liveLog}
      liveLogRef={liveLogRef}
      historyEntries={historyEntries}
      historySelected={historySelected}
      selectedHistory={selectedHistory}
      shellReady={shellReady}
      shellSessionId={shellSessionId}
      shellAgentId={shellAgentId}
      shellInput={shellInput}
      shellOutput={shellOutput}
      shellLogRef={shellLogRef}
      fileAgentId={fileAgentId}
      fileBrowserPath={fileBrowserPath}
      fileEntries={sortRemoteEntries(fileEntries)}
      selectedRemoteEntry={selectedRemoteEntry}
      remoteUploadTarget={remoteUploadTarget}
      fileInputRef={fileInputRef}
      uploads={uploads}
      downloads={downloads}
      fileLog={fileLog}
      fileLogRef={fileLogRef}
      onTabChange={setActiveTab}
      onReload={() => window.location.reload()}
      onSelectAgent={handleSelectAgent}
      onCommandInputChange={setCommandInput}
      onDispatchCommand={handleDispatchCommand}
      onSelectHistory={setHistorySelected}
      onShellInputChange={setShellInput}
      onSendShellInput={handleSendShellInput}
      onCloseShell={() => {
        if (!shellSessionId) {
          return;
        }
        sendEvent(socketRef.current, 'shell:close', { sessionId: shellSessionId });
      }}
      onBrowseUp={() => handleBrowseDirectory(parentRemotePath(fileBrowserPath))}
      onRefreshFiles={handleRefreshFiles}
      onRemoteUploadTargetChange={setRemoteUploadTarget}
      onChooseFile={handleChooseFile}
      onUploadSelection={handleUploadSelection}
      onDownloadEntry={handleDownloadEntry}
      onSelectRemoteEntry={(entry) => {
        setSelectedRemoteEntry(entry);
        if (entry.isDir) {
          handleBrowseDirectory(entry.path);
        }
      }}
      shortAgentId={shortAgentId}
      renderAgentSummary={renderAgentSummary}
      renderCommand={renderCommand}
      formatTimestamp={formatTimestamp}
      formatBytes={formatBytes}
    />
  );
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
  event: OperatorEvent;
  setAgents: Dispatch<SetStateAction<Record<string, AgentRecord>>>;
  setHistoryCache: Dispatch<SetStateAction<Record<string, HistoryEntry[]>>>;
  setHistoryEntries: Dispatch<SetStateAction<HistoryEntry[]>>;
  setHistorySelected: Dispatch<SetStateAction<number>>;
  setLiveLog: Dispatch<SetStateAction<string>>;
  setStatusLine: Dispatch<SetStateAction<string>>;
  activeTab: TabKey;
  historyAgentId: string;
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
      }));
      break;
    case 'agent_cached':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: event.payload,
          status: 'OFFLINE',
        },
      }));
      break;
    case 'agent_dead':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: event.payload,
          status: 'DEAD',
        },
      }));
      break;
    case 'agent_removed':
      setAgents((current) => ({
        ...current,
        [event.agentId]: {
          id: event.agentId,
          summary: current[event.agentId]?.summary || event.payload || 'OFFLINE',
          status: 'OFFLINE',
        },
      }));
      break;
    case 'history_updated':
      try {
        const entry = parseHistoryEntryPayload(event.payload);
        if (!entry) {
          break;
        }
        setHistoryCache((current) => {
          const existing = current[event.agentId] ?? [];
          const merged = [entry, ...existing.filter((item) => item.taskId !== entry.taskId)].slice(
            0,
            200,
          );
          return { ...current, [event.agentId]: merged };
        });
        if (activeTab === 'history' && historyAgentId === event.agentId) {
          setHistoryEntries((current) =>
            [entry, ...current.filter((item) => item.taskId !== entry.taskId)].slice(0, 200),
          );
          setHistorySelected(0);
        }
      } catch {
        // Ignore malformed history payloads from the gateway.
      }
      break;
    default:
      break;
  }

  appendLiveLog(setLiveLog, formatOperatorEvent(event));
  if (event.type !== 'output' && event.type !== 'history_updated') {
    setStatusLine(event.payload || event.type);
  }
}

function parseHistoryEntryPayload(payload: string): HistoryEntry | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as
      | Partial<HistoryEntry>
      | {
          task_id?: string;
          agent_id?: string;
          executed_at?: number;
          completed_at?: number;
          command?: string;
          args?: string;
          output?: string;
        };

    const taskId =
      (parsed as Partial<HistoryEntry>).taskId || (parsed as { task_id?: string }).task_id || '';
    const agentId =
      (parsed as Partial<HistoryEntry>).agentId || (parsed as { agent_id?: string }).agent_id || '';
    if (!taskId || !agentId) {
      return null;
    }

    return {
      taskId,
      agentId,
      command: (parsed as Partial<HistoryEntry>).command || '',
      args: (parsed as Partial<HistoryEntry>).args || '',
      output: (parsed as Partial<HistoryEntry>).output || '',
      executedAt:
        (parsed as Partial<HistoryEntry>).executedAt ||
        (parsed as { executed_at?: number }).executed_at ||
        0,
      completedAt:
        (parsed as Partial<HistoryEntry>).completedAt ||
        (parsed as { completed_at?: number }).completed_at ||
        0,
    };
  } catch {
    return null;
  }
}

function mergeHistoryEntries(current: HistoryEntry[], incoming: HistoryEntry[]) {
  if (incoming.length === 0) {
    return current;
  }

  const byTaskId = new Map<string, HistoryEntry>();
  for (const item of current) {
    byTaskId.set(item.taskId, item);
  }
  for (const item of incoming) {
    byTaskId.set(item.taskId, item);
  }

  return [...byTaskId.values()]
    .sort((left, right) => right.executedAt - left.executedAt)
    .slice(0, 200);
}

function applyShellEvent(
  event: ShellEvent,
  handlers: {
    setShellSessionId: Dispatch<SetStateAction<string>>;
    setShellAgentId: Dispatch<SetStateAction<string>>;
    setShellReady: Dispatch<SetStateAction<boolean>>;
    setShellOutput: Dispatch<SetStateAction<string>>;
    setShellInput: Dispatch<SetStateAction<string>>;
    setStatusLine: Dispatch<SetStateAction<string>>;
  },
) {
  switch (event.type) {
    case 'open_ok':
      handlers.setShellSessionId(event.sessionId);
      handlers.setShellAgentId(event.agentId);
      handlers.setShellReady(true);
      handlers.setShellOutput('Shell connected.\n');
      handlers.setStatusLine(`Shell connected to ${shortAgentId(event.agentId)}`);
      break;
    case 'open_error':
      handlers.setShellReady(false);
      handlers.setShellSessionId('');
      handlers.setStatusLine(event.message || 'Shell open error');
      break;
    case 'output':
      handlers.setShellOutput((current) =>
        trimText(current + sanitizeTerminalText(event.data || ''), MAX_LOG_LENGTH),
      );
      break;
    case 'closed':
      handlers.setShellReady(false);
      handlers.setShellSessionId('');
      handlers.setShellInput('');
      handlers.setStatusLine(event.message || 'Shell closed');
      break;
    default:
      break;
  }
}

function applyFileEvent(
  event: FileEvent,
  handlers: {
    fileListTransferId: string;
    setFileListTransferId: (value: string) => void;
    setFileAgentId: Dispatch<SetStateAction<string>>;
    setFileBrowserPath: Dispatch<SetStateAction<string>>;
    setFileEntries: Dispatch<SetStateAction<RemoteFileEntry[]>>;
    setFileLog: Dispatch<SetStateAction<LogEntry[]>>;
    setUploads: Dispatch<SetStateAction<Record<string, UploadRecord>>>;
    downloads: Record<string, DownloadRecord>;
    setDownloads: Dispatch<SetStateAction<Record<string, DownloadRecord>>>;
    setStatusLine: Dispatch<SetStateAction<string>>;
    setSelectedRemoteEntry: Dispatch<SetStateAction<RemoteFileEntry | null>>;
  },
) {
  switch (event.type) {
    case 'list_entry':
      if (event.transferId !== handlers.fileListTransferId) {
        return;
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
      ]);
      break;
    case 'list_done':
      if (event.transferId !== handlers.fileListTransferId) {
        return;
      }
      handlers.setFileListTransferId('');
      handlers.setFileAgentId(event.agentId);
      handlers.setFileBrowserPath(event.path || '.');
      handlers.setSelectedRemoteEntry(null);
      handlers.setStatusLine(`Listed ${event.path || '.'} for ${shortAgentId(event.agentId)}`);
      break;
    case 'upload_progress':
      handlers.setUploads((current) => {
        const upload = current[event.transferId];
        if (!upload) {
          return current;
        }
        return {
          ...current,
          [event.transferId]: {
            ...upload,
            totalBytes: event.totalBytes || upload.totalBytes,
            transferredBytes: event.transferredBytes || upload.transferredBytes,
          },
        };
      });
      break;
    case 'upload_done':
      handlers.setUploads((current) => {
        const next = { ...current };
        delete next[event.transferId];
        return next;
      });
      appendFileLog(
        handlers.setFileLog,
        'success',
        `Upload finished: ${event.path || event.transferId}`,
      );
      handlers.setStatusLine('Upload completed');
      break;
    case 'download_chunk':
      handlers.setDownloads((current) => {
        const record = current[event.transferId];
        if (!record) {
          return current;
        }
        const nextChunk = event.data ? base64ToBytes(event.data) : new Uint8Array();
        return {
          ...current,
          [event.transferId]: {
            ...record,
            totalBytes: event.totalBytes || record.totalBytes,
            transferredBytes: event.transferredBytes || record.transferredBytes,
            chunks: [...record.chunks, nextChunk],
          },
        };
      });
      break;
    case 'download_done': {
      const record = handlers.downloads[event.transferId];
      if (record) {
        triggerBrowserDownload(record);
      }
      handlers.setDownloads((current) => {
        const next = { ...current };
        delete next[event.transferId];
        return next;
      });
      appendFileLog(
        handlers.setFileLog,
        'success',
        `Download finished: ${event.path || event.transferId}`,
      );
      handlers.setStatusLine('Download completed');
      break;
    }
    case 'error':
      handlers.setUploads((current) => {
        const next = { ...current };
        delete next[event.transferId];
        return next;
      });
      handlers.setDownloads((current) => {
        const next = { ...current };
        delete next[event.transferId];
        return next;
      });
      if (event.transferId === handlers.fileListTransferId) {
        handlers.setFileListTransferId('');
      }
      appendFileLog(handlers.setFileLog, 'error', event.message || 'File transfer error');
      handlers.setStatusLine(event.message || 'File transfer error');
      break;
    default:
      break;
  }
}

function requestRemoteList(
  socket: WebSocket | null,
  agentId: string,
  path: string,
  setTransferId: (value: string) => void,
  setStatusLine: Dispatch<SetStateAction<string>>,
) {
  const transferId = createId();
  setTransferId(transferId);
  const sent = sendEvent(socket, 'file:list', {
    transferId,
    agentId,
    path,
  });
  if (!sent) {
    setTransferId('');
    setStatusLine('Gateway not connected. Retry file listing.');
    return;
  }
  setStatusLine(`Loading ${path} for ${shortAgentId(agentId)}...`);
}

function renderAgentSummary(agent: AgentRecord) {
  if (agent.status === 'OFFLINE') {
    return renderOfflineSummary(agent.summary);
  }
  return agent.summary;
}

function renderOfflineSummary(summary: string) {
  const trimmed = summary.trim();
  if (!trimmed) {
    return '[OFFLINE]';
  }
  const start = trimmed.lastIndexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end === trimmed.length - 1) {
    return `${trimmed.slice(0, start).trim()} [OFFLINE]`;
  }
  return `${trimmed} [OFFLINE]`;
}

function buildAgentOrder(
  agents: Record<string, AgentRecord>,
  historyCache: Record<string, HistoryEntry[]>,
) {
  const ids = new Set<string>(Object.keys(agents));
  for (const [agentId, entries] of Object.entries(historyCache)) {
    if (entries.length > 0) {
      ids.add(agentId);
    }
  }
  return [...ids].sort((left, right) => {
    const leftStatus = agents[left]?.status || 'OFFLINE';
    const rightStatus = agents[right]?.status || 'OFFLINE';
    const rankDiff = statusRank(leftStatus) - statusRank(rightStatus);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return left.localeCompare(right);
  });
}

function statusRank(status: AgentStatus) {
  switch (status) {
    case 'ALIVE':
    case 'IDLE':
    case 'BUSY':
      return 0;
    case 'DEAD':
      return 1;
    case 'OFFLINE':
      return 2;
  }
}

function isAgentLive(status: AgentStatus) {
  return status === 'ALIVE' || status === 'IDLE' || status === 'BUSY';
}

function shortAgentId(id?: string | null) {
  const safe = (id || '').trim();
  if (!safe) {
    return 'unknown';
  }
  return safe.length <= 8 ? safe : safe.slice(0, 8);
}

function extractStatus(payload: string) {
  const start = payload.lastIndexOf('[');
  const end = payload.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start + 1) {
    return '';
  }
  return payload.slice(start + 1, end);
}

function renderCommand(entry: Pick<HistoryEntry, 'command' | 'args'>) {
  return entry.args ? `${entry.command} ${entry.args}` : entry.command;
}

function appendLiveLog(setter: Dispatch<SetStateAction<string>>, chunk: string) {
  setter((current) => trimText(current + chunk, MAX_LOG_LENGTH));
}

function appendFileLog(
  setter: Dispatch<SetStateAction<LogEntry[]>>,
  tone: LogEntry['tone'],
  text: string,
) {
  setter((current) => [...current.slice(-80), { id: createId(), tone, text }]);
}

function formatOperatorEvent(event: OperatorEvent) {
  switch (event.type) {
    case 'agent_joined':
      return `[+] agent:${shortAgentId(event.agentId)} ${event.payload}\n`;
    case 'agent_cached':
      return `[.] agent:${shortAgentId(event.agentId)} ${event.payload}\n`;
    case 'agent_removed':
      return `[-] agent:${shortAgentId(event.agentId)} ${event.payload}\n`;
    case 'agent_dead':
      return `[!] agent:${shortAgentId(event.agentId)} ${event.payload}\n`;
    case 'ack':
      return `[~] agent:${shortAgentId(event.agentId)} ${event.payload}\n`;
    case 'error':
      return `[x] agent:${shortAgentId(event.agentId)} ${event.payload}\n`;
    case 'history_updated':
      return '';
    case 'output':
      return sanitizeTerminalText(event.payload);
    default:
      return `[?] ${event.type} ${event.payload}\n`;
  }
}

function trimText(text: string, maxLength: number) {
  return text.length <= maxLength ? text : text.slice(text.length - maxLength);
}

function sanitizeTerminalText(input: string) {
  return input.replace(/\r/g, '');
}

function formatTimestamp(value: number) {
  if (!value) {
    return '-';
  }
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function getGatewayUrl() {
  if (import.meta.env.VITE_GATEWAY_URL) {
    return import.meta.env.VITE_GATEWAY_URL as string;
  }
  return 'http://kali.local:8080';
}

function toWebSocketUrl(url: string) {
  if (url.startsWith('https://')) {
    return `${url.replace('https://', 'wss://')}/ws`;
  }
  if (url.startsWith('http://')) {
    return `${url.replace('http://', 'ws://')}/ws`;
  }
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return `${url}/ws`;
  }
  return `ws://${url}/ws`;
}

function parseEnvelope(data: string) {
  try {
    return JSON.parse(data) as WebsocketEnvelope;
  } catch {
    return null;
  }
}

function sendEvent(socket: WebSocket | null, event: string, payload: unknown) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify({ event, payload }));
  return true;
}

function resolveRemotePath(base: string, target: string) {
  const trimmed = target.trim();
  if (!trimmed) {
    return base || '.';
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return trimmed;
  }
  if (base === '.' || !base) {
    return trimmed;
  }
  const separator = base.includes('\\') || trimmed.includes('\\') ? '\\' : '/';
  const normalized = `${base}${separator}${trimmed}`.replaceAll('\\', '/');
  const parts = normalized.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  if (normalized.startsWith('/')) {
    return `/${stack.join('/')}`;
  }
  return stack.join(separator) || '.';
}

function parentRemotePath(path: string) {
  if (!path || path === '.' || path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return path || '.';
  }
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/, '');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '.';
  }
  return normalized.slice(0, lastSlash);
}

function sortRemoteEntries(entries: RemoteFileEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function pathBase(path: string) {
  const normalized = path.replace(/[/\\]+$/, '');
  const lastSlash = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const value of bytes) {
    binary += String.fromCharCode(value);
  }
  return window.btoa(binary);
}

function base64ToBytes(data: string) {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function triggerBrowserDownload(record: DownloadRecord) {
  const parts = record.chunks.map(
    (chunk) =>
      chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
  );
  const blob = new Blob(parts, { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = record.filename || `download-${createId()}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export default App;
