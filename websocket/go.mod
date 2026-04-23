module github.com/ardhptr21/c2-websocket/websocket

go 1.24.2

require (
	github.com/ardhptr21/c2-grpc v0.0.0
	github.com/gorilla/websocket v1.5.3
	google.golang.org/grpc v1.64.0
)

require (
	golang.org/x/net v0.22.0 // indirect
	golang.org/x/sys v0.38.0 // indirect
	golang.org/x/text v0.17.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20240318140521-94a12d6c2237 // indirect
	google.golang.org/protobuf v1.36.1 // indirect
)

replace github.com/ardhptr21/c2-grpc => ../../c2-grpc
