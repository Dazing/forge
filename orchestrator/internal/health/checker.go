// Package health implements the Phase 0 liveness/readiness model.
//
// Liveness is the process/event-loop: the HTTP server is up. Readiness is the
// set of required dependency probes — migrated/writable SQLite, GitLab reach
// able with the current token, publisher socket, and worker reachability.
// Failure detail is redacted to dependency names and status only; no secret
// values ever reach the response body.
package health

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"time"

	"factory.local/platform/orchestrator/internal/config"
	"factory.local/platform/orchestrator/internal/store"
)

// Dependency is one required probe.
type Dependency struct {
	// Name is the stable, non-secret identifier reported in readiness.
	Name string
	// Check reports the probe result. A nil error means the dependency is
	// ready.
	Check func(ctx context.Context) error
}

// Result is the per-dependency outcome reported to callers.
type Result struct {
	Dependency string
	Ready      bool
	// Status is a bounded, non-secret status string.
	Status string
}

// Checker runs the set of required dependency probes.
type Checker struct {
	deps []Dependency
}

// NewChecker returns a Checker over the given dependencies. The list is
// immutable after construction and safe for concurrent use.
func NewChecker(deps ...Dependency) *Checker {
	return &Checker{deps: deps}
}

// Check runs every dependency and returns one Result per dependency, in
// order.
func (c *Checker) Check(ctx context.Context) []Result {
	out := make([]Result, 0, len(c.deps))
	for _, d := range c.deps {
		if d.Check == nil {
			continue
		}
		err := d.Check(ctx)
		r := Result{Dependency: d.Name, Ready: err == nil}
		if err != nil {
			r.Status = "unavailable"
		} else {
			r.Status = "ok"
		}
		out = append(out, r)
	}
	return out
}

// Ready reports whether every required dependency is ready. With no
// dependencies registered it is ready.
func (c *Checker) Ready(ctx context.Context) bool {
	for _, r := range c.Check(ctx) {
		if !r.Ready {
			return false
		}
	}
	return true
}

// DatabaseDependency probes the SQLite store for migration and writability.
func DatabaseDependency(st *store.Store) Dependency {
	return Dependency{
		Name: "database",
		Check: func(ctx context.Context) error {
			return st.HealthProbe(ctx)
		},
	}
}

// GitLabDependency probes GitLab reachability with the current token. The
// token is read from its named environment variable at probe time and is
// never stored, logged, or returned.
func GitLabDependency(cfg config.Config) Dependency {
	return Dependency{
		Name: "gitlab",
		Check: func(ctx context.Context) error {
			token, err := config.GitLabToken(cfg)
			if err != nil {
				return err
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.GitLab.BaseURL+"/api/v4/version", nil)
			if err != nil {
				return err
			}
			req.Header.Set("Authorization", "Bearer "+token)
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			if err != nil {
				return fmt.Errorf("gitlab probe: %v", err)
			}
			defer resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				return fmt.Errorf("gitlab probe: status %d", resp.StatusCode)
			}
			return nil
		},
	}
}

// PublisherDependency probes the trusted publisher Unix socket by dialing it.
func PublisherDependency(cfg config.Config) Dependency {
	return Dependency{
		Name: "publisher",
		Check: func(ctx context.Context) error {
			dialer := &net.Dialer{Timeout: 2 * time.Second}
			conn, err := dialer.DialContext(ctx, "unix", cfg.PublisherSocket)
			if err != nil {
				return fmt.Errorf("publisher probe: %v", err)
			}
			conn.Close()
			return nil
		},
	}
}

// WorkerDependency probes the forced-command worker reachability target.
func WorkerDependency(cfg config.Config) Dependency {
	return Dependency{
		Name: "worker",
		Check: func(ctx context.Context) error {
			addr := net.JoinHostPort(cfg.Worker.Host, strconv.Itoa(cfg.Worker.Port))
			dialer := &net.Dialer{Timeout: 2 * time.Second}
			conn, err := dialer.DialContext(ctx, "tcp", addr)
			if err != nil {
				return fmt.Errorf("worker probe: %v", err)
			}
			conn.Close()
			return nil
		},
	}
}
