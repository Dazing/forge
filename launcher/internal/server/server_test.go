package server_test
import (
	"context"
	"crypto/ed25519"
	"strings"
	"testing"
	"time"
	"factory.local/platform/launcher/internal/replay"
	"factory.local/platform/launcher/internal/runspec"
	"factory.local/platform/launcher/internal/server"
)

func newServer(t *testing.T) (*server.Server, ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := runspec.NewKeyPair()
	if err != nil {
		t.Fatalf("NewKeyPair: %v", err)
	}
	ledger, err := replay.Open(t.TempDir() + "/replay.jsonl")
	if err != nil {
		t.Fatalf("replay.Open: %v", err)
	}
	return &server.Server{
		Ledger:    ledger,
		Now:       func() time.Time { return time.Now().UTC() },
		PublicKey: pub,
	}, pub, priv
}

func validSpec(runID string, expiresAt time.Time) runspec.RunSpec {
	return runspec.RunSpec{
		RunID:            runID,
		IssuedAt:         expiresAt.Add(-5 * time.Minute),
		ExpiresAt:        expiresAt,
		BaseSHA:          "0123456789abcdef0123456789abcdef01234567",
		Role:             "implement",
		Image:            runspec.DigestRef{Digest: "sha256:" + "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"},
		Assets:           runspec.DigestRef{Digest: "sha256:" + "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"},
		Command:          "implement-issue",
		Skills:           []string{"go-implementation"},
		Limits:           runspec.Limits{WallClockSec: 5400, CPU: "4", Memory: "16Gi", OutputBytes: 20_971_520},
		NetworkPolicy:    runspec.NetworkPolicy{EgressMode: "proxy", EgressHosts: []string{"proxy.factory.internal:443"}},
		WorkspaceArchive: "archives/run-001.tar.zst",
	}
}

func TestHandle_AcceptsValidCreate(t *testing.T) {
	srv, _, priv := newServer(t)
	now := time.Now().UTC()
	env, _ := runspec.NewEnvelope(validSpec("run-001", now.Add(10*time.Minute)), priv)

	res, err := srv.Handle(context.Background(), server.OpRequest{Op: server.OpCreate, Env: env})
	if err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if res.RunID != "run-001" {
		t.Fatalf("RunID = %q, want run-001", res.RunID)
	}
	if res.State != "running" {
		t.Fatalf("State = %q, want running", res.State)
	}
}

func TestHandle_RejectsInvalidSignature(t *testing.T) {
	_, _, priv := newServer(t)
	pubB, _, _ := runspec.NewKeyPair()
	now := time.Now().UTC()
	// Sign with priv, but verify against pubB.
	env, _ := runspec.NewEnvelope(validSpec("run-002", now.Add(10*time.Minute)), priv)

	// Use a server with a different public key.
	ledger, _ := replay.Open(t.TempDir() + "/replay.jsonl")
	srv := &server.Server{Ledger: ledger, Now: func() time.Time { return now }, PublicKey: pubB}

	if _, err := srv.Handle(context.Background(), server.OpRequest{Op: server.OpCreate, Env: env}); err == nil {
		t.Fatal("Handle accepted a spec signed with the wrong key")
	}
}

func TestHandle_RejectsReplayedRunID(t *testing.T) {
	srv, _, priv := newServer(t)
	now := time.Now().UTC()
	env, _ := runspec.NewEnvelope(validSpec("run-replay", now.Add(10*time.Minute)), priv)

	// First call succeeds.
	if _, err := srv.Handle(context.Background(), server.OpRequest{Op: server.OpCreate, Env: env}); err != nil {
		t.Fatalf("first Handle: %v", err)
	}
	// Second call with the same run ID must fail.
	_, err := srv.Handle(context.Background(), server.OpRequest{Op: server.OpStatus, Env: env})
	if err == nil {
		t.Fatal("Handle accepted a replayed run ID")
	}
	if !strings.Contains(err.Error(), "already accepted") {
		t.Fatalf("error %q does not mention replay", err)
	}
}

func TestHandle_RejectsExpiredSpec(t *testing.T) {
	srv, _, priv := newServer(t)
	now := time.Now().UTC()
	env, _ := runspec.NewEnvelope(validSpec("run-expired", now.Add(-1*time.Hour)), priv)

	if _, err := srv.Handle(context.Background(), server.OpRequest{Op: server.OpCreate, Env: env}); err == nil {
		t.Fatal("Handle accepted an expired spec")
	}
}

func TestHandle_RejectsUnsupportedOp(t *testing.T) {
	srv, _, priv := newServer(t)
	now := time.Now().UTC()
	env, _ := runspec.NewEnvelope(validSpec("run-bad-op", now.Add(10*time.Minute)), priv)

	_, err := srv.Handle(context.Background(), server.OpRequest{Op: server.Op("shell"), Env: env})
	if err == nil {
		t.Fatal("Handle accepted an unsupported op")
	}
	if !strings.Contains(err.Error(), "unsupported op") {
		t.Fatalf("error %q does not mention unsupported op", err)
	}
}
