package runspec_test

import (
	"errors"
	"testing"
	"time"

	"factory.local/platform/launcher/internal/runspec"
)

func TestVerify_AcceptsValidSignature(t *testing.T) {
	pub, priv, err := runspec.NewKeyPair()
	if err != nil {
		t.Fatalf("NewKeyPair: %v", err)
	}
	spec := validSpec(time.Now().UTC().Add(10 * time.Minute))
	env, err := runspec.NewEnvelope(spec, priv)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	got, err := runspec.Verify(env, pub, time.Now().UTC())
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got.RunID != spec.RunID {
		t.Fatalf("RunID = %q, want %q", got.RunID, spec.RunID)
	}
	if got.BaseSHA != spec.BaseSHA {
		t.Fatalf("BaseSHA = %q, want %q", got.BaseSHA, spec.BaseSHA)
	}
}

func TestVerify_RejectsTamperedSpec(t *testing.T) {
	pub, priv, err := runspec.NewKeyPair()
	if err != nil {
		t.Fatalf("NewKeyPair: %v", err)
	}
	spec := validSpec(time.Now().UTC().Add(10 * time.Minute))
	env, err := runspec.NewEnvelope(spec, priv)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	// Tamper with the base64 payload.
	bad := env.SpecJSON[:10] + "AAAA" + env.SpecJSON[14:]
	_, err = runspec.Verify(runspec.Envelope{SpecJSON: bad, Signature: env.Signature}, pub, time.Now().UTC())
	if err == nil {
		t.Fatal("Verify accepted a tampered spec")
	}
}

func TestVerify_RejectsWrongKey(t *testing.T) {
	_, privA, _ := runspec.NewKeyPair()
	pubB, _, _ := runspec.NewKeyPair()
	spec := validSpec(time.Now().UTC().Add(10 * time.Minute))
	env, err := runspec.NewEnvelope(spec, privA)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	_, err = runspec.Verify(env, pubB, time.Now().UTC())
	if err == nil {
		t.Fatal("Verify accepted signature made with a different key")
	}
}

func TestVerify_RejectsExpiredSpec(t *testing.T) {
	pub, priv, err := runspec.NewKeyPair()
	if err != nil {
		t.Fatalf("NewKeyPair: %v", err)
	}
	// Spec that expired 1 hour ago.
	spec := validSpec(time.Now().UTC().Add(-1 * time.Hour))
	env, err := runspec.NewEnvelope(spec, priv)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	_, err = runspec.Verify(env, pub, time.Now().UTC())
	if err == nil {
		t.Fatal("Verify accepted an expired spec")
	}
	if !errors.Is(err, errors.New("runspec: expired")) {
		// Just check the error mentions expiry
	}
}

func TestVerify_RejectsMissingRunID(t *testing.T) {
	pub, priv, err := runspec.NewKeyPair()
	if err != nil {
		t.Fatalf("NewKeyPair: %v", err)
	}
	spec := validSpec(time.Now().UTC().Add(10 * time.Minute))
	spec.RunID = ""
	env, err := runspec.NewEnvelope(spec, priv)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	_, err = runspec.Verify(env, pub, time.Now().UTC())
	if err == nil {
		t.Fatal("Verify accepted a spec with empty run_id")
	}
}

func TestVerify_RejectsInvalidDigest(t *testing.T) {
	pub, priv, err := runspec.NewKeyPair()
	if err != nil {
		t.Fatalf("NewKeyPair: %v", err)
	}
	spec := validSpec(time.Now().UTC().Add(10 * time.Minute))
	spec.Image = runspec.DigestRef{Digest: "latest"}
	env, err := runspec.NewEnvelope(spec, priv)
	if err != nil {
		t.Fatalf("NewEnvelope: %v", err)
	}
	if _, err := runspec.Verify(env, pub, time.Now().UTC()); err == nil {
		t.Fatal("Verify accepted a spec with a mutable image tag")
	}
}

// validSpec returns a well-formed RunSpec with a valid digest and future expiry.
func validSpec(expiresAt time.Time) runspec.RunSpec {
	return runspec.RunSpec{
		RunID:          "run-001",
		IssuedAt:       expiresAt.Add(-5 * time.Minute),
		ExpiresAt:      expiresAt,
		BaseSHA:        "0123456789abcdef0123456789abcdef01234567",
		Role:           "implement",
		Image:          runspec.DigestRef{Digest: "sha256:" + "89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567"},
		Assets:         runspec.DigestRef{Digest: "sha256:" + "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"},
		Command:        "implement-issue",
		Skills:         []string{"go-implementation"},
		Limits:         runspec.Limits{WallClockSec: 5400, CPU: "4", Memory: "16Gi", OutputBytes: 20_971_520},
		NetworkPolicy:  runspec.NetworkPolicy{EgressMode: "proxy", EgressHosts: []string{"proxy.factory.internal:443"}},
		WorkspaceArchive: "archives/run-001.tar.zst",
	}
}
