package manifest

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

const registryPrefix = "registry.factory.internal/software-factory/apps/example"

// validManifestYAML is a complete, safe .factory.yaml that every fixture
// fixture directory can start from.
const validManifestYAML = `version: 1

agent:
  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright@sha256:4e6f7d7dc83db10bfa3bd6fb3bdaf0c75d35db3ecf8d228ef690593bcb11d9e5

commands:
  bootstrap: ./scripts/bootstrap
  check: ./scripts/check
  build: ./scripts/build

artifacts:
  image: registry.factory.internal/software-factory/apps/example

services:
  - postgres-test

network:
  egress_hosts:
    - registry.npmjs.org
    - api.nuget.org
`

// writeManifest writes a .factory.yaml into dir and returns the manifest path
// relative to dir.
func writeManifest(t *testing.T, dir, content string) string {
	t.Helper()
	manifestPath := filepath.Join(dir, ".factory.yaml")
	if err := os.WriteFile(manifestPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
	return ".factory.yaml"
}

// writeScript writes an executable script at dir/scripts/name.
func writeScript(t *testing.T, dir, name, body string) {
	t.Helper()
	scriptsDir := filepath.Join(dir, "scripts")
	if err := os.MkdirAll(scriptsDir, 0o755); err != nil {
		t.Fatalf("make scripts dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(scriptsDir, name), []byte(body), 0o755); err != nil {
		t.Fatalf("write script %s: %v", name, err)
	}
}

// fixtureDir builds a complete, valid fixture directory with the three
// required executable scripts.
func fixtureDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeScript(t, dir, "bootstrap", "#!/bin/sh\nexit 0\n")
	writeScript(t, dir, "check", "#!/bin/sh\nexit 0\n")
	writeScript(t, dir, "build", "#!/bin/sh\nexit 0\n")
	return dir
}

// TestLoad_Valid accepts a complete valid repository contract.
func TestLoad_Valid(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, validManifestYAML)

	m, err := Load(dir, ".factory.yaml", registryPrefix)
	if err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	if m.Version != 1 {
		t.Fatalf("version = %d, want 1", m.Version)
	}
}

// TestLoad_ValidFixtureDirectory exercises the checked-in valid fixture from
// the testdata tree.
func TestLoad_ValidFixtureDirectory(t *testing.T) {
	dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", "valid"))
	if err != nil {
		t.Fatalf("resolve testdata: %v", err)
	}
	if _, err := Load(dir, ".factory.yaml", registryPrefix); err != nil {
		t.Fatalf("testdata/valid rejected: %v", err)
	}
}

// TestLoad_InvalidFixtureDirectories exercises the checked-in invalid fixtures
// from the testdata tree, one per rejection class.
func TestLoad_InvalidFixtureDirectories(t *testing.T) {
	cases := []struct {
		dir       string
		wantField string
	}{
		{"invalid-mutable-image", "agent.image"},
		{"invalid-path-escape", "commands.check"},
		{"invalid-service", "services[0]"},
		{"invalid-egress", "network.egress_hosts[0]"},
		{"invalid-command", "commands.build"},
	}
	for _, tc := range cases {
		t.Run(tc.dir, func(t *testing.T) {
			dir, err := filepath.Abs(filepath.Join("..", "..", "testdata", tc.dir))
			if err != nil {
				t.Fatalf("resolve testdata: %v", err)
			}
			_, err = Load(dir, ".factory.yaml", registryPrefix)
			if err == nil {
				t.Fatal("manifest accepted; want rejection")
			}
			merr := assertManifestError(t, err, tc.wantField)
			if merr.Field != tc.wantField {
				t.Fatalf("field = %q, want %q", merr.Field, tc.wantField)
			}
		})
	}
}

// assertManifestError reports whether err is a ManifestError whose field
// prefix matches wantField.
func assertManifestError(t *testing.T, err error, wantField string) *ManifestError {
	t.Helper()
	var merr *ManifestError
	if !errors.As(err, &merr) {
		t.Fatalf("expected *ManifestError, got %v", err)
	}
	if wantField != "" && merr.Field != wantField {
		t.Fatalf("manifest error field = %q, want %q", merr.Field, wantField)
	}
	return merr
}

// TestLoad_InvalidMutableImage rejects a floating-tag agent image.
func TestLoad_InvalidMutableImage(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, "version: 1\n"+
		"agent:\n  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright:latest\n"+
		"commands:\n  bootstrap: ./scripts/bootstrap\n  check: ./scripts/check\n  build: ./scripts/build\n"+
		"artifacts:\n  image: "+registryPrefix+"\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	assertManifestError(t, err, "agent.image")
}

// TestLoad_InvalidPathEscape rejects a command path containing ..
func TestLoad_InvalidPathEscape(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, "version: 1\n"+
		"agent:\n  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright@sha256:4e6f7d7dc83db10bfa3bd6fb3bdaf0c75d35db3ecf8d228ef690593bcb11d9e5\n"+
		"commands:\n  bootstrap: ./scripts/bootstrap\n  check: ../outside/check\n  build: ./scripts/build\n"+
		"artifacts:\n  image: "+registryPrefix+"\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	assertManifestError(t, err, "commands.check")
}

// TestLoad_InvalidService rejects an unsupported service name.
func TestLoad_InvalidService(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, "version: 1\n"+
		"agent:\n  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright@sha256:4e6f7d7dc83db10bfa3bd6fb3bdaf0c75d35db3ecf8d228ef690593bcb11d9e5\n"+
		"commands:\n  bootstrap: ./scripts/bootstrap\n  check: ./scripts/check\n  build: ./scripts/build\n"+
		"artifacts:\n  image: "+registryPrefix+"\n"+
		"services:\n  - mongodb-test\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	merr := assertManifestError(t, err, "")
	if merr.Field != "services[0]" {
		t.Fatalf("field = %q, want services[0]", merr.Field)
	}
}

// TestLoad_InvalidEgress rejects a private-IP egress host.
func TestLoad_InvalidEgress(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, "version: 1\n"+
		"agent:\n  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright@sha256:4e6f7d7dc83db10bfa3bd6fb3bdaf0c75d35db3ecf8d228ef690593bcb11d9e5\n"+
		"commands:\n  bootstrap: ./scripts/bootstrap\n  check: ./scripts/check\n  build: ./scripts/build\n"+
		"artifacts:\n  image: "+registryPrefix+"\n"+
		"network:\n  egress_hosts:\n    - 10.0.0.5\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	merr := assertManifestError(t, err, "")
	if merr.Field != "network.egress_hosts[0]" {
		t.Fatalf("field = %q, want network.egress_hosts[0]", merr.Field)
	}
}

// TestLoad_InvalidCommand rejects a non-executable command script.
func TestLoad_InvalidCommand(t *testing.T) {
	dir := t.TempDir()
	// A non-executable build script; bootstrap/check are executable.
	writeScript(t, dir, "bootstrap", "#!/bin/sh\nexit 0\n")
	writeScript(t, dir, "check", "#!/bin/sh\nexit 0\n")
	if err := os.MkdirAll(filepath.Join(dir, "scripts"), 0o755); err != nil {
		t.Fatalf("make scripts: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "scripts", "build"), []byte("#!/bin/sh\nexit 0\n"), 0o644); err != nil {
		t.Fatalf("write build: %v", err)
	}
	writeManifest(t, dir, validManifestYAML)
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	assertManifestError(t, err, "commands.build")
}

// TestLoad_UnknownKey fails closed on an extra top-level field.
func TestLoad_UnknownKey(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, validManifestYAML+"cache:\n  enabled: true\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	if err == nil {
		t.Fatal("unknown top-level key accepted; want rejection")
	}
}

// TestLoad_InlineArguments rejects a command value that embeds arguments.
func TestLoad_InlineArguments(t *testing.T) {
	dir := fixtureDir(t)
	// A command that smuggles an argument via a shell fragment.
	writeManifest(t, dir, "version: 1\n"+
		"agent:\n  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright@sha256:4e6f7d7dc83db10bfa3bd6fb3bdaf0c75d35db3ecf8d228ef690593bcb11d9e5\n"+
		"commands:\n  bootstrap: ./scripts/bootstrap\n  check: ./scripts/check\n  build: ./scripts/build --flag\n"+
		"artifacts:\n  image: "+registryPrefix+"\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	assertManifestError(t, err, "commands.build")
}

// TestLoad_MissingCommand rejects a command path that does not exist.
func TestLoad_MissingCommand(t *testing.T) {
	dir := t.TempDir()
	writeScript(t, dir, "bootstrap", "#!/bin/sh\nexit 0\n")
	writeScript(t, dir, "check", "#!/bin/sh\nexit 0\n")
	// No build script.
	writeManifest(t, dir, validManifestYAML)
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	assertManifestError(t, err, "commands.build")
}

// TestLoad_WrongVersion rejects an unsupported manifest version.
func TestLoad_WrongVersion(t *testing.T) {
	dir := fixtureDir(t)
	writeManifest(t, dir, "version: 2\n"+
		"agent:\n  image: registry.factory.internal/software-factory/platform/agent-images/node-dotnet-playwright@sha256:4e6f7d7dc83db10bfa3bd6fb3bdaf0c75d35db3ecf8d228ef690593bcb11d9e5\n"+
		"commands:\n  bootstrap: ./scripts/bootstrap\n  check: ./scripts/check\n  build: ./scripts/build\n"+
		"artifacts:\n  image: "+registryPrefix+"\n")
	_, err := Load(dir, ".factory.yaml", registryPrefix)
	assertManifestError(t, err, "version")
}
