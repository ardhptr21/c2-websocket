export type TabKey = 'live' | 'history' | 'shell' | 'files';

export type AgentStatus = 'ALIVE' | 'IDLE' | 'BUSY' | 'DEAD' | 'OFFLINE';

export type AgentRecord = {
  id: string;
  summary: string;
  status: AgentStatus;
};

export type GatewayStatus = {
  connected: boolean;
  server: string;
  message?: string;
};

export type OperatorEvent = {
  type: string;
  agentId: string;
  payload: string;
};

export type HistoryEntry = {
  taskId: string;
  agentId: string;
  command: string;
  args: string;
  output: string;
  executedAt: number;
  completedAt: number;
};

export type HistoryResult = {
  requestId?: string;
  agentId: string;
  entries: HistoryEntry[];
};

export type ShellEvent = {
  type: string;
  sessionId: string;
  agentId: string;
  data?: string;
  message?: string;
};

export type FileEvent = {
  type: string;
  transferId: string;
  agentId: string;
  path?: string;
  data?: string;
  message?: string;
  isDir?: boolean;
  size?: number;
  modifiedAt?: number;
  totalBytes?: number;
  transferredBytes?: number;
};

export type RemoteFileEntry = {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
};

export type DownloadRecord = {
  filename: string;
  chunks: Uint8Array[];
  totalBytes: number;
  transferredBytes: number;
};

export type UploadRecord = {
  name: string;
  totalBytes: number;
  transferredBytes: number;
};

export type LogEntry = {
  id: string;
  tone: 'neutral' | 'success' | 'error' | 'muted';
  text: string;
};

export type WebsocketEnvelope<T = unknown> = {
  event: string;
  payload: T;
};
