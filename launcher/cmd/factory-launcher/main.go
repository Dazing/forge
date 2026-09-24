// factory-launcher is the forced-command binary for the factory worker VM.
//
// It is installed as the OpenSSH forced command for the launcher keypair.
// It accepts exactly one framed JSON request on stdin, verifies the signed
// run spec, claims the run ID against the replay ledger, and writes one
// framed JSON response to stdout. No shell, PTY, or forwarding is possible
// because OpenSSH's forced-command directive replaces the shell entirely.
//
// Usage:
//
//	factory-launcher -ledger <path> -pubkey <hex-or-pem-file>
//
// The forced-command entry in authorized_keys is:
//
//	command="/usr/bin/factory-launcher -ledger /var/factory/replay.jsonl -pubkey /etc/factory/launcher-pub.pem" no-pty,no-port-forwarding,no-agent-forwarding ssh-ed25519 AAAA...
package main

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"os"
	"time"

	"factory.local/platform/launcher/internal/replay"
	"factory.local/platform/launcher/internal/server"
)

func main() {
	ledgerPath := flag.String("ledger", "/var/factory/replay.jsonl", "replay ledger path")
	pubKeyPath := flag.String("pubkey", "/etc/factory/launcher-pub.pem", "Ed25519 verification key (PEM or hex)")
	flag.Parse()

	publicKey, err := loadPublicKey(*pubKeyPath)
	if err != nil {
		fatal(err)
	}

	ledger, err := replay.Open(*ledgerPath)
	if err != nil {
		fatal(err)
	}
	defer ledger.Close()

	srv := &server.Server{
		Ledger:    ledger,
		Now:       func() time.Time { return time.Now().UTC() },
		PublicKey: publicKey,
	}

	// Read exactly one JSON-framed request from stdin.
	req, err := readFrame(os.Stdin)
	if err != nil {
		fatal(err)
	}

	res, err := srv.Handle(context.Background(), req)
	out := struct {
		Op     server.Op       `json:"op"`
		Result server.OpResult `json:"result,omitempty"`
		Err    string          `json:"error,omitempty"`
	}{Op: req.Op, Result: res}
	if err != nil {
		out.Err = err.Error()
	}
	writeFrame(os.Stdout, out)
}

// readFrame reads one JSON object from r.
func readFrame(r *os.File) (server.OpRequest, error) {
	data, err := bufio.NewReader(r).ReadBytes('\n')
	if err != nil {
		return server.OpRequest{}, fmt.Errorf("read frame: %w", err)
	}
	var req server.OpRequest
	if err := json.Unmarshal(data, &req); err != nil {
		return server.OpRequest{}, fmt.Errorf("parse frame: %w", err)
	}
	return req, nil
}

// writeFrame writes one JSON object followed by a newline to w.
func writeFrame(w *os.File, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fatal(fmt.Errorf("write frame: %w", err))
	}
	if _, err := w.Write(append(b, '\n')); err != nil {
		fatal(fmt.Errorf("write frame: %w", err))
	}
}

// loadPublicKey loads an Ed25519 public key from a PEM or hex file.
func loadPublicKey(path string) (ed25519.PublicKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("load pubkey: %w", err)
	}
	// Try PEM first.
	if block, _ := pem.Decode(data); block != nil {
		if len(block.Bytes) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("pubkey: PEM is not Ed25519 (%d bytes)", len(block.Bytes))
		}
		return ed25519.PublicKey(block.Bytes), nil
	}
	// Try raw hex.
	raw, err := hex.DecodeString(string(data))
	if err != nil {
		return nil, fmt.Errorf("pubkey: not PEM or hex: %w", err)
	}
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("pubkey: hex is not Ed25519 (%d bytes)", len(raw))
	}
	return ed25519.PublicKey(raw), nil
}

// fatal writes a minimal JSON error frame to stdout and exits with status 1.
func fatal(err error) {
	b, _ := json.Marshal(map[string]string{"error": err.Error()})
	fmt.Fprintln(os.Stdout, string(b))
	os.Exit(1)
}
