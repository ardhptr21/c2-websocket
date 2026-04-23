.PHONY: build clean run

BUILD_DIR := builds
BINARY := websocket-gateway-linux-amd64

build:
	@mkdir -p $(BUILD_DIR)
	GOOS=linux GOARCH=amd64 go build -o $(BUILD_DIR)/$(BINARY) .

run:
	go run .

clean:
	rm -rf $(BUILD_DIR)
