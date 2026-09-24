// Package runspec defines the signed canonical run specification that the
// factory-launcher accepts as its sole input. An Envelope carries the
// canonical JSON bytes of a RunSpec and an Ed25519 signature over those bytes.
// The launcher verifies the signature, checks expiry, and rejects replayed
// run IDs before accepting any lifecycle operation.
package runspec

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// RunSpec is the canonical signed run specification. All references are
// content-addressed digests; mutable image tags are not accepted.
type RunSpec struct {
	// RunID is a unique identifier for this run; it is claimed durably by the
	// launcher and must never be reused.
	RunID string `json:"run_id"`
	// IssuedAt is when the orchestrator created the spec (UTC).
	IssuedAt time.Time `json:"issued_at"`
	// ExpiresAt is the deadline after which this spec is rejected (UTC).
	ExpiresAt time.Time `json:"expires_at"`
	// BaseSHA is the immutable Git commit SHA the agent workspace is checked out at.
	BaseSHA string `json:"base_sha"`
	// Role is the agent role (e.g. "plan", "implement", "review").
	Role string `json:"role"`
	// Image is the agent-image OCI artifact digest.
	Image DigestRef `json:"image"`
	// Assets is the agent-assets OCI artifact digest.
	Assets DigestRef `json:"assets"`
	// Command is the selected role command identifier.
	Command string `json:"command"`
	// Skills is the list of selected skill identifiers.
	Skills []string `json:"skills,omitempty"`
	// Limits are the resource constraints for this run.
	Limits Limits `json:"limits"`
	// Services are the disposable service containers declared for this run.
	Services []Service `json:"services,omitempty"`
	// NetworkPolicy is the egress firewall policy for the run network.
	NetworkPolicy NetworkPolicy `json:"network_policy"`
	// WorkspaceArchive is the reference to the credential-free checkout archive.
	WorkspaceArchive string `json:"workspace_archive"`
}

// DigestRef is a content-addressed reference to an OCI artifact.
// Only the digest is accepted; mutable tags are rejected at validation.
type DigestRef struct {
	Digest string `json:"digest"`
}

// Validate ensures the digest is a sha256 content-addressed reference.
func (d DigestRef) Validate() error {
	if !strings.HasPrefix(d.Digest, "sha256:") || len(d.Digest) != len("sha256:")+64 {
		return fmt.Errorf("runspec: invalid digest %q: must be sha256:<64-hex>", d.Digest)
	}
	return nil
}

// Limits are per-run resource constraints.
type Limits struct {
	WallClockSec int64  `json:"wall_clock_sec"`
	CPU          string `json:"cpu"`
	Memory       string `json:"memory"`
	OutputBytes  int64  `json:"output_bytes"`
}

// Service describes a disposable service container.
type Service struct {
	Name  string    `json:"name"`
	Image DigestRef `json:"image"`
	Port  int       `json:"port"`
}

// NetworkPolicy describes the egress firewall policy for the run network.
// Mode "none" (plan/review), "proxy" (implement/repair), "browser" (exploratory).
type NetworkPolicy struct {
	EgressMode  string   `json:"egress_mode"`
	EgressHosts []string `json:"egress_hosts,omitempty"`
}

// Envelope is the wire format the launcher receives: the canonical spec JSON
// and its Ed25519 signature, both base64-encoded.
//
// SpecJSON is base64(raw canonical bytes of RunSpec).
// Signature is base64(ed25519.Sign(privateKey, rawCanonicalBytes)).
type Envelope struct {
	SpecJSON  string `json:"spec_json"`
	Signature string `json:"signature"`
}

// NewEnvelope signs spec with privateKey and returns the envelope.
// The canonical bytes are computed deterministically from the spec.
func NewEnvelope(spec RunSpec, privateKey ed25519.PrivateKey) (Envelope, error) {
	caBytes, err := CanonicalBytes(spec)
	if err != nil {
		return Envelope{}, fmt.Errorf("runspec: canonicalize: %w", err)
	}
	sig := ed25519.Sign(privateKey, caBytes)
	return Envelope{
		SpecJSON:  base64.StdEncoding.EncodeToString(caBytes),
		Signature: base64.StdEncoding.EncodeToString(sig),
	}, nil
}

// CanonicalBytes returns the deterministic JSON encoding of spec.
// The encoding is: json.Marshal of the struct with all timestamps normalized
// to UTC. Field order is the Go declaration order (fixed by the struct).
// No map fields are used, so iteration order is not a concern.
func CanonicalBytes(spec RunSpec) ([]byte, error) {
	spec.IssuedAt = spec.IssuedAt.UTC()
	spec.ExpiresAt = spec.ExpiresAt.UTC()
	b, err := json.Marshal(spec)
	if err != nil {
		return nil, fmt.Errorf("runspec: marshal: %w", err)
	}
	return b, nil
}

// Verify decodes and verifies the envelope: Ed25519 signature, expiry, and
// run-ID presence. It returns the verified RunSpec.
// now must be the current UTC time.
func Verify(envelope Envelope, publicKey ed25519.PublicKey, now time.Time) (RunSpec, error) {
	var spec RunSpec

	caBytes, err := base64.StdEncoding.DecodeString(envelope.SpecJSON)
	if err != nil {
		return spec, fmt.Errorf("runspec: bad SpecJSON base64: %w", err)
	}
	sig, err := base64.StdEncoding.DecodeString(envelope.Signature)
	if err != nil {
		return spec, fmt.Errorf("runspec: bad Signature base64: %w", err)
	}
	if !ed25519.Verify(publicKey, caBytes, sig) {
		return spec, errors.New("runspec: invalid Ed25519 signature")
	}
	if err := json.Unmarshal(caBytes, &spec); err != nil {
		return spec, fmt.Errorf("runspec: unmarshal spec: %w", err)
	}
	if spec.RunID == "" {
		return spec, errors.New("runspec: run_id is empty")
	}
	if err := spec.Image.Validate(); err != nil {
		return spec, fmt.Errorf("runspec: image digest: %w", err)
	}
	if err := spec.Assets.Validate(); err != nil {
		return spec, fmt.Errorf("runspec: assets digest: %w", err)
	}
	for _, svc := range spec.Services {
		if err := svc.Image.Validate(); err != nil {
			return spec, fmt.Errorf("runspec: service %q image digest: %w", svc.Name, err)
		}
	}
	if spec.ExpiresAt.Before(now) {
		return spec, fmt.Errorf("runspec: expired at %s", spec.ExpiresAt.UTC().Format(time.RFC3339))
	}
	return spec, nil
}

// NewKeyPair generates an Ed25519 key pair for testing and bootstrap.
func NewKeyPair() (ed25519.PublicKey, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, fmt.Errorf("runspec: keygen: %w", err)
	}
	return pub, priv, nil
}
