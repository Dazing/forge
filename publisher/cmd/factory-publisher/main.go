// factory-publisher listens on a Unix socket owned by the publisher OS
// user (not the orchestrator user) and accepts PublishRequest frames.
// It validates branches, re-clones the expected base, applies patches
// with no fuzz, rejects unsafe content, and pushes only factory/* branches.
//
// No TCP listener. No arbitrary ref. No source-branch write path.
//
// Usage:
//
//	factory-publisher -socket /run/factory/publisher.sock
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"os"

	"factory.local/platform/publisher/internal/protocol"
	"factory.local/platform/publisher/internal/publish"
)

func main() {
	socketPath := flag.String("socket", "/run/factory/publisher.sock", "Unix socket path")
	flag.Parse()

	// Restrictive permissions: only the publisher OS user and root may connect.
	_ = os.Remove(*socketPath)
	ln, err := net.Listen("unix", *socketPath)
	if err != nil {
		log.Fatalf("listen socket: %v", err)
	}
	if err := os.Chmod(*socketPath, 0o600); err != nil {
		log.Fatalf("chmod socket: %v", err)
	}
	defer ln.Close()
	defer os.Remove(*socketPath)

	log.Printf("factory-publisher listening on %s", *socketPath)

	// Phase 0: use a no-op GitClient; Phase 3 replaces with the real
	// implementation that shells out to git under the publisher OS user.
	svc := &publish.Service{Git: noopGitClient{}}

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			continue
		}
		go handleConn(conn, svc)
	}
}

// handleConn reads one JSON PublishRequest, runs Publish, and writes the
// JSON PublishResult.
func handleConn(conn net.Conn, svc *publish.Service) {
	defer conn.Close()
	var req protocol.PublishRequest
	if err := json.NewDecoder(conn).Decode(&req); err != nil {
		_ = json.NewEncoder(conn).Encode(protocol.PublishResult{Error: fmt.Sprintf("decode: %v", err)})
		return
	}
	res, _ := svc.Publish(context.Background(), req)
	_ = json.NewEncoder(conn).Encode(res)
}

// noopGitClient satisfies publish.GitClient without touching Git.
// It is replaced by the real implementation in Phase 3.
type noopGitClient struct{}

func (noopGitClient) Clone(_ context.Context, _, _, _ string) error      { return fmt.Errorf("not implemented in Phase 0") }
func (noopGitClient) ApplyPatch(_ context.Context, _, _ string) error   { return fmt.Errorf("not implemented in Phase 0") }
func (noopGitClient) CheckSubmodules(_ string) error                    { return nil }
func (noopGitClient) CheckEscapingSymlinks(_ string) error              { return nil }
func (noopGitClient) CheckCredentialMarkers(_ context.Context, _ string) error { return nil }
func (noopGitClient) Commit(_ context.Context, _, _ string) (string, error) { return "", fmt.Errorf("not implemented in Phase 0") }
func (noopGitClient) Push(_ context.Context, _, _ string) error         { return fmt.Errorf("not implemented in Phase 0") }
