import {
  ArrowClockwise,
  ClockCounterClockwise,
  Command,
  DownloadSimple,
  Folders,
  Pulse,
  TerminalWindow,
  UploadSimple,
} from '@phosphor-icons/react';
import type { ChangeEvent, RefObject } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type {
  AgentRecord,
  AgentStatus,
  DownloadRecord,
  GatewayStatus,
  HistoryEntry,
  LogEntry,
  RemoteFileEntry,
  TabKey,
  UploadRecord,
} from '@/types/operator';

type ConsoleLayoutProps = {
  gatewayUrl: string;
  gatewayStatus: GatewayStatus;
  socketConnected: boolean;
  statusLine: string;
  activeTab: TabKey;
  selectedAgentId: string;
  selectedAgent?: AgentRecord;
  agentOrder: string[];
  agents: Record<string, AgentRecord>;
  commandInput: string;
  liveLog: string;
  liveLogRef: RefObject<HTMLPreElement | null>;
  historyEntries: HistoryEntry[];
  historySelected: number;
  selectedHistory: HistoryEntry | null;
  shellReady: boolean;
  shellSessionId: string;
  shellAgentId: string;
  shellInput: string;
  shellOutput: string;
  shellLogRef: RefObject<HTMLPreElement | null>;
  fileAgentId: string;
  fileBrowserPath: string;
  fileEntries: RemoteFileEntry[];
  selectedRemoteEntry: RemoteFileEntry | null;
  remoteUploadTarget: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  uploads: Record<string, UploadRecord>;
  downloads: Record<string, DownloadRecord>;
  fileLog: LogEntry[];
  fileLogRef: RefObject<HTMLDivElement | null>;
  onTabChange: (tab: TabKey) => void;
  onReload: () => void;
  onSelectAgent: (agentId: string) => void;
  onCommandInputChange: (value: string) => void;
  onDispatchCommand: () => void;
  onSelectHistory: (index: number) => void;
  onShellInputChange: (value: string) => void;
  onSendShellInput: () => void;
  onCloseShell: () => void;
  onBrowseUp: () => void;
  onRefreshFiles: () => void;
  onRemoteUploadTargetChange: (value: string) => void;
  onChooseFile: () => void;
  onUploadSelection: (event: ChangeEvent<HTMLInputElement>) => void;
  onDownloadEntry: () => void;
  onSelectRemoteEntry: (entry: RemoteFileEntry) => void;
  shortAgentId: (id: string) => string;
  renderAgentSummary: (agent: AgentRecord) => string;
  renderCommand: (entry: Pick<HistoryEntry, 'command' | 'args'>) => string;
  formatTimestamp: (value: number) => string;
  formatBytes: (value: number) => string;
};

function ConsoleLayout(props: ConsoleLayoutProps) {
  const {
    gatewayUrl,
    gatewayStatus,
    socketConnected,
    statusLine,
    activeTab,
    selectedAgentId,
    selectedAgent,
    agentOrder,
    agents,
    commandInput,
    liveLog,
    liveLogRef,
    historyEntries,
    historySelected,
    selectedHistory,
    shellReady,
    shellSessionId,
    shellAgentId,
    shellInput,
    shellOutput,
    shellLogRef,
    fileAgentId,
    fileBrowserPath,
    fileEntries,
    selectedRemoteEntry,
    remoteUploadTarget,
    fileInputRef,
    uploads,
    downloads,
    fileLog,
    fileLogRef,
    onTabChange,
    onReload,
    onSelectAgent,
    onCommandInputChange,
    onDispatchCommand,
    onSelectHistory,
    onShellInputChange,
    onSendShellInput,
    onCloseShell,
    onBrowseUp,
    onRefreshFiles,
    onRemoteUploadTargetChange,
    onChooseFile,
    onUploadSelection,
    onDownloadEntry,
    onSelectRemoteEntry,
    shortAgentId,
    renderAgentSummary,
    renderCommand,
    formatTimestamp,
    formatBytes,
  } = props;

  return (
    <main className="h-screen overflow-hidden bg-background text-foreground">
      <div className="mx-auto grid h-full max-w-7xl grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden p-4 md:p-6">
        <Card>
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle className="text-base uppercase tracking-wider">C2 Web Console</CardTitle>
              <p className="text-xs text-muted-foreground">
                Simple operator view for commands, shell, and files.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge connected={socketConnected && gatewayStatus.connected} />
              <Button variant="outline" size="icon-sm" onClick={onReload}>
                <ArrowClockwise className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
            <div>Gateway: {gatewayUrl}</div>
            <div>Server: {gatewayStatus.server || 'Unavailable'}</div>
            <div>Status: {statusLine}</div>
          </CardContent>
        </Card>

        <div className="grid min-h-0 items-stretch gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
          <Card className="flex min-h-0 flex-col">
            <CardHeader>
              <CardTitle className="text-xs uppercase tracking-wider">Agents</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 space-y-2 overflow-auto">
              {agentOrder.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  No agents
                </p>
              ) : (
                agentOrder.map((agentId) => {
                  const agent = agents[agentId] ?? {
                    id: agentId,
                    summary: 'OFFLINE',
                    status: 'OFFLINE' as AgentStatus,
                  };
                  const isSelected = selectedAgentId === agentId;
                  return (
                    <button
                      key={agentId}
                      type="button"
                      onClick={() => onSelectAgent(agentId)}
                      className={cn(
                        'w-full rounded-md border p-2 text-left transition',
                        isSelected ? 'border-primary bg-muted' : 'border-border hover:bg-muted/60',
                      )}
                    >
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold tracking-wide">
                          {shortAgentId(agentId)}
                        </span>
                        <Badge variant={statusToBadge(agent.status)}>{agent.status}</Badge>
                      </div>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {renderAgentSummary(agent)}
                      </p>
                    </button>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card className="flex min-h-0 flex-col">
            <CardHeader className="gap-3">
              <div className="flex flex-wrap gap-2">
                <TabButton
                  active={activeTab === 'live'}
                  onClick={() => onTabChange('live')}
                  icon={<Pulse className="size-4" />}
                >
                  Live
                </TabButton>
                <TabButton
                  active={activeTab === 'history'}
                  onClick={() => onTabChange('history')}
                  icon={<ClockCounterClockwise className="size-4" />}
                >
                  History
                </TabButton>
                <TabButton
                  active={activeTab === 'shell'}
                  onClick={() => onTabChange('shell')}
                  icon={<TerminalWindow className="size-4" />}
                >
                  Shell
                </TabButton>
                <TabButton
                  active={activeTab === 'files'}
                  onClick={() => onTabChange('files')}
                  icon={<Folders className="size-4" />}
                >
                  Files
                </TabButton>
              </div>
              <div className="text-xs text-muted-foreground">
                Selected: {selectedAgent ? shortAgentId(selectedAgent.id) : 'none'}
              </div>
            </CardHeader>
            <CardContent className="flex-1 min-h-0">
              {activeTab === 'live' ? (
                <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-3">
                  <pre
                    ref={liveLogRef}
                    className="h-full min-h-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-6 whitespace-pre-wrap break-words"
                  >
                    {liveLog}
                  </pre>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <Input
                      value={commandInput}
                      onChange={(event) => onCommandInputChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          onDispatchCommand();
                        }
                      }}
                      placeholder="Type command"
                    />
                    <Button onClick={onDispatchCommand}>
                      <Command className="size-4" />
                      Dispatch
                    </Button>
                  </div>
                </div>
              ) : null}

              {activeTab === 'history' ? (
                <div className="grid h-full min-h-0 gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
                  <div className="min-h-0 space-y-2 overflow-auto rounded-md border p-2">
                    {historyEntries.length === 0 ? (
                      <p className="p-3 text-sm text-muted-foreground">No history entries</p>
                    ) : (
                      historyEntries.map((entry, index) => (
                        <button
                          key={entry.taskId}
                          type="button"
                          onClick={() => onSelectHistory(index)}
                          className={cn(
                            'w-full rounded-md border p-2 text-left text-xs',
                            historySelected === index
                              ? 'border-primary bg-muted'
                              : 'border-border hover:bg-muted/50',
                          )}
                        >
                          <div className="text-[11px] text-muted-foreground">
                            {formatTimestamp(entry.executedAt)}
                          </div>
                          <div className="mt-1 font-medium">{renderCommand(entry)}</div>
                        </button>
                      ))
                    )}
                  </div>
                  <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
                    <div className="rounded-md border p-3 text-xs text-muted-foreground">
                      {selectedHistory ? (
                        <>
                          <div>Task: {selectedHistory.taskId}</div>
                          <div>Agent: {shortAgentId(selectedHistory.agentId)}</div>
                          <div>Executed: {formatTimestamp(selectedHistory.executedAt)}</div>
                          <div>Completed: {formatTimestamp(selectedHistory.completedAt)}</div>
                        </>
                      ) : (
                        <div>No history selected</div>
                      )}
                    </div>
                    <pre className="h-full min-h-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-6 whitespace-pre-wrap break-words">
                      {selectedHistory?.output || 'No output'}
                    </pre>
                  </div>
                </div>
              ) : null}

              {activeTab === 'shell' ? (
                <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto_auto] gap-3">
                  <pre
                    ref={shellLogRef}
                    className="h-full min-h-0 overflow-auto rounded-md border bg-muted/30 p-3 text-xs leading-6 whitespace-pre-wrap break-words"
                  >
                    {shellOutput}
                  </pre>
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                    <Input
                      value={shellInput}
                      onChange={(event) => onShellInputChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          onSendShellInput();
                        }
                      }}
                      placeholder={shellReady ? 'Shell input' : 'Shell not ready'}
                    />
                    <Button onClick={onSendShellInput} disabled={!shellReady}>
                      Send
                    </Button>
                    <Button variant="outline" onClick={onCloseShell} disabled={!shellSessionId}>
                      Close
                    </Button>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    Session: {shellSessionId || 'pending'} on{' '}
                    {shellAgentId ? shortAgentId(shellAgentId) : 'none'}
                  </div>
                </div>
              ) : null}

              {activeTab === 'files' ? (
                <div className="grid h-full min-h-0 gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
                  <div className="grid min-h-0 grid-rows-[auto_auto_minmax(0,1fr)] gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" onClick={onBrowseUp}>
                        Up
                      </Button>
                      <Button variant="outline" onClick={onRefreshFiles}>
                        Refresh
                      </Button>
                      <span className="text-xs text-muted-foreground">{fileBrowserPath}</span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                      <Input
                        value={remoteUploadTarget}
                        onChange={(event) => onRemoteUploadTargetChange(event.target.value)}
                        placeholder="Remote target"
                      />
                      <Button onClick={onChooseFile}>
                        <UploadSimple className="size-4" />
                        Upload
                      </Button>
                      <Button
                        variant="outline"
                        onClick={onDownloadEntry}
                        disabled={!selectedRemoteEntry || selectedRemoteEntry.isDir}
                      >
                        <DownloadSimple className="size-4" />
                        Download
                      </Button>
                    </div>
                    <div className="overflow-auto rounded-md border">
                      {fileEntries.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">No entries</p>
                      ) : (
                        <div className="divide-y">
                          {fileEntries.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              onClick={() => onSelectRemoteEntry(entry)}
                              className={cn(
                                'grid w-full grid-cols-[1fr_auto] gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50',
                                selectedRemoteEntry?.path === entry.path && 'bg-muted',
                              )}
                            >
                              <div>
                                <div className="font-medium">
                                  {entry.isDir ? 'DIR' : 'FILE'} {entry.name}
                                </div>
                                <div className="text-muted-foreground">{entry.path}</div>
                              </div>
                              <div className="text-right text-muted-foreground">
                                <div>{entry.isDir ? '-' : formatBytes(entry.size)}</div>
                                <div>
                                  {entry.modifiedAt ? formatTimestamp(entry.modifiedAt) : '-'}
                                </div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-2">
                    <div className="space-y-2">
                      {Object.entries(uploads).map(([id, upload]) => (
                        <ProgressRow
                          key={id}
                          label={`Upload ${upload.name}`}
                          value={upload.transferredBytes}
                          total={upload.totalBytes}
                          formatBytes={formatBytes}
                        />
                      ))}
                      {Object.entries(downloads).map(([id, download]) => (
                        <ProgressRow
                          key={id}
                          label={`Download ${download.filename}`}
                          value={download.transferredBytes}
                          total={download.totalBytes}
                          formatBytes={formatBytes}
                        />
                      ))}
                      {Object.keys(uploads).length === 0 && Object.keys(downloads).length === 0 ? (
                        <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">
                          No active transfers
                        </p>
                      ) : null}
                    </div>
                    <div
                      ref={fileLogRef}
                      className="overflow-auto rounded-md border bg-muted/30 p-3 text-xs"
                    >
                      {fileLog.map((entry) => (
                        <div key={entry.id} className={toneClass(entry.tone)}>
                          {entry.text}
                        </div>
                      ))}
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={onUploadSelection}
                  />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        <div className="text-xs text-muted-foreground">
          Active files agent: {fileAgentId ? shortAgentId(fileAgentId) : 'none'}
        </div>
      </div>
    </main>
  );
}

function TabButton({
  active,
  icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  children: string;
  onClick: () => void;
}) {
  return (
    <Button variant={active ? 'default' : 'outline'} size="sm" onClick={onClick}>
      {icon}
      {children}
    </Button>
  );
}

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <Badge variant={connected ? 'success' : 'destructive'}>
      {connected ? 'connected' : 'offline'}
    </Badge>
  );
}

function statusToBadge(status: AgentStatus): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (status) {
    case 'ALIVE':
      return 'success';
    case 'IDLE':
    case 'BUSY':
      return 'warning';
    case 'DEAD':
      return 'destructive';
    case 'OFFLINE':
      return 'secondary';
  }
}

function toneClass(tone: LogEntry['tone']) {
  switch (tone) {
    case 'success':
      return 'mb-1 text-emerald-700';
    case 'error':
      return 'mb-1 text-rose-700';
    case 'muted':
      return 'mb-1 text-muted-foreground';
    case 'neutral':
      return 'mb-1 text-foreground';
  }
}

function ProgressRow({
  label,
  value,
  total,
  formatBytes,
}: {
  label: string;
  value: number;
  total: number;
  formatBytes: (value: number) => string;
}) {
  const ratio = total > 0 ? Math.min(value / total, 1) : 0;

  return (
    <div className="rounded-md border p-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className="text-muted-foreground">
          {formatBytes(value)} / {formatBytes(total)}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export { ConsoleLayout };
