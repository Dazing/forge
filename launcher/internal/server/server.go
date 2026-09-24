// Package server implements the forced-command lifecycle boundary for
// factory-launcher. It accepts one framed request on stdin, verifies the
// signed run spec, claims the run ID against the replay ledger, and
// dispatches the requested operation (create, status, cancel, destroy).
//
// No shell, PTY, or arbitrary command protocol is exposed.
package server

import (
	"context"
	"fmt"
	"time"

	"factory.local/platform/launcher/internal/adapter"
	"factory.local/platform/launcher/internal/replay"
	"factory.local/platform/launcher/internal/runspec"
)

// Op is the lifecycle operation requested by the orchestrator.
type Op string

const (
	OpCreate   Op = "create"
	OpStatus   Op = "status"
	OpCancel   Op = "cancel"
	OpDestroy  Op = "destroy"
)

// OpRequest is the framed request the orchestrator sends to the forced command.
// Each operation is bound to a signed run spec envelope.
type OpRequest struct {
	Op      Op             `json:"op"`
	Env     runspec.Envelope `json:"env"`
}

// OpResult is the response to a single lifecycle operation.
type OpResult struct {
	Op      Op             `json:"op"`
	RunID   string         `json:"run_id"`
	State   string         `json:"state"`
	// ResultJSON is the adapter output artifact (only set for create on completion).
	ResultJSON []byte `json:"result_json,omitempty"`
}

// Server owns the replay ledger and the current clock. It is created once
// per launcher process and handles one request at a time (stdin-driven).
type Server struct {
	// Ledger is the persistent replay store.
	Ledger *replay.Store
	// Now is the clock source; tests inject a fixed time.
	Now func() time.Time
	// PublicKey is the launcher's Ed25519 verification key.
	PublicKey []byte
}

// Handle verifies a single framed request and returns the operation result.
// It rejects:
//   - invalid or missing signatures
//   - expired specs
//   - replayed run IDs
//   - unsupported operations
//   - mutable image tags (via runspec.Verify digest validation)
func (s *Server) Handle(ctx context.Context, req OpRequest) (OpResult, error) {
	now := s.Now()
	spec, err := runspec.Verify(req.Env, s.PublicKey, now)
	if err != nil {
		return OpResult{}, fmt.Errorf("server: verify run-spec: %w", err)
	}

	// Claim the run ID; replay is rejected here.
	if err := s.Ledger.Claim(ctx, spec.RunID, spec.ExpiresAt); err != nil {
		return OpResult{}, fmt.Errorf("server: claim run %q: %w", spec.RunID, err)
	}

	switch req.Op {
	case OpCreate, OpStatus, OpCancel, OpDestroy:
		// Lifecycle operations are accepted. Phase 0 returns a state
		// placeholder; Phase 3 wires real Docker lifecycle.
		state := "accepted"
		switch req.Op {
		case OpCreate:
			state = "running"
		case OpStatus:
			state = "unknown"
		case OpCancel:
			state = "cancelling"
		case OpDestroy:
			state = "destroying"
		}
		return OpResult{Op: req.Op, RunID: spec.RunID, State: state}, nil
	default:
		return OpResult{}, fmt.Errorf("server: unsupported op %q", req.Op)
	}
}

// AdapterRef is a thin wrapper to keep the adapter import explicit in the
// server package without leaking adapter internals into callers.
type AdapterRef struct {
	Adapter adapter.Contract
}

// NewAdapterRef returns an AdapterRef.
func NewAdapterRef(a adapter.Contract) AdapterRef {
	return AdapterRef{Adapter: a}
}
