// Package config defines the typed Phase 0 configuration for the orchestrator
// and loads it from the environment. Secrets are supplied by environment
// variable name, never logged or persisted.
package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// GitLabProbe holds the GitLab health-probe configuration.
type GitLabProbe struct {
	// BaseURL is the GitLab REST base (e.g. https://gitlab.factory.tailnet.local).
	BaseURL string
	// TokenEnv names the environment variable holding the GitLab token value.
	// The value is read at probe time and never stored in Config, logged, or
	// persisted.
	TokenEnv string
}

// WorkerProbe holds the forced-command worker reachability configuration.
type WorkerProbe struct {
	// Host is the worker VM address (tailnet or internal VLAN).
	Host string
	// Port is the OpenSSH forced-command port.
	Port int
}

// Config is the Phase 0 orchestrator configuration.
type Config struct {
	// DatabasePath is the SQLite file the service opens in WAL mode.
	DatabasePath string
	// BusyTimeout bounds how long a write blocks waiting for the WAL lock.
	BusyTimeout time.Duration
	// GitLab is the GitLab health-probe target and token source.
	GitLab GitLabProbe
	// PublisherSocket is the Unix-socket path of the trusted publisher.
	PublisherSocket string
	// Worker is the forced-command worker reachability target.
	Worker WorkerProbe
	// ListenAddr is the address the health server binds (tailnet only).
	ListenAddr string
}

// Load reads configuration from the environment. Every field is required; a
// missing or invalid value is an error so the service fails fast at startup.
func Load() (Config, error) {
	cfg := Config{}
	var errs []string

	cfg.DatabasePath = os.Getenv("ORCHESTRATOR_DB_PATH")
	if cfg.DatabasePath == "" {
		errs = append(errs, "ORCHESTRATOR_DB_PATH is required")
	}

	if raw := os.Getenv("ORCHESTRATOR_BUSY_TIMEOUT_MS"); raw != "" {
		ms, err := strconv.Atoi(raw)
		if err != nil || ms <= 0 {
			errs = append(errs, fmt.Sprintf("ORCHESTRATOR_BUSY_TIMEOUT_MS must be a positive integer (ms), got %q", raw))
		} else {
			cfg.BusyTimeout = time.Duration(ms) * time.Millisecond
		}
	} else {
		cfg.BusyTimeout = 5 * time.Second
	}

	cfg.GitLab.BaseURL = os.Getenv("ORCHESTRATOR_GITLAB_BASE_URL")
	if cfg.GitLab.BaseURL == "" {
		errs = append(errs, "ORCHESTRATOR_GITLAB_BASE_URL is required")
	}
	cfg.GitLab.TokenEnv = os.Getenv("ORCHESTRATOR_GITLAB_TOKEN_ENV")
	if cfg.GitLab.TokenEnv == "" {
		errs = append(errs, "ORCHESTRATOR_GITLAB_TOKEN_ENV is required")
	}

	cfg.PublisherSocket = os.Getenv("ORCHESTRATOR_PUBLISHER_SOCKET")
	if cfg.PublisherSocket == "" {
		errs = append(errs, "ORCHESTRATOR_PUBLISHER_SOCKET is required")
	}

	cfg.Worker.Host = os.Getenv("ORCHESTRATOR_WORKER_HOST")
	if cfg.Worker.Host == "" {
		errs = append(errs, "ORCHESTRATOR_WORKER_HOST is required")
	}
	if raw := os.Getenv("ORCHESTRATOR_WORKER_PORT"); raw != "" {
		port, err := strconv.Atoi(raw)
		if err != nil || port <= 0 || port > 65535 {
			errs = append(errs, fmt.Sprintf("ORCHESTRATOR_WORKER_PORT must be a valid port, got %q", raw))
		} else {
			cfg.Worker.Port = port
		}
	} else {
		cfg.Worker.Port = 22
	}

	cfg.ListenAddr = os.Getenv("ORCHESTRATOR_LISTEN_ADDR")
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = "127.0.0.1:8443"
	}

	if len(errs) > 0 {
		return Config{}, fmt.Errorf("config: %s", join(errs))
	}
	return cfg, nil
}

// GitLabToken returns the GitLab token value resolved from the named
// environment variable. It is read only when a probe is about to use it and
// is never retained, logged, or persisted.
func GitLabToken(cfg Config) (string, error) {
	val := os.Getenv(cfg.GitLab.TokenEnv)
	if val == "" {
		return "", fmt.Errorf("config: gitlab token env %q is not set", cfg.GitLab.TokenEnv)
	}
	return val, nil
}

func join(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += "; "
		}
		out += p
	}
	return out
}
