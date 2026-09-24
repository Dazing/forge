package httpserver_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"factory.local/platform/orchestrator/internal/health"
	"factory.local/platform/orchestrator/internal/httpserver"
)

type readyBody struct {
	Ready        bool            `json:"ready"`
	Dependencies []health.Result `json:"dependencies"`
}

func allPass() *health.Checker {
	return health.NewChecker(
		health.Dependency{Name: "database", Check: func(ctx context.Context) error { return nil }},
		health.Dependency{Name: "gitlab", Check: func(ctx context.Context) error { return nil }},
	)
}

func oneFailing() *health.Checker {
	return health.NewChecker(
		health.Dependency{Name: "database", Check: func(ctx context.Context) error { return nil }},
		health.Dependency{Name: "gitlab", Check: func(ctx context.Context) error {
			return errors.New("gitlab unreachable")
		}},
	)
}

func TestLiveReturns200(t *testing.T) {
	srv := httptest.NewServer(httpserver.New(allPass()))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/health/live")
	if err != nil {
		t.Fatalf("GET /health/live: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("live status = %d, want 200", resp.StatusCode)
	}
}

func TestReady200WhenAllPass(t *testing.T) {
	srv := httptest.NewServer(httpserver.New(allPass()))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/health/ready")
	if err != nil {
		t.Fatalf("GET /health/ready: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("ready status = %d, want 200", resp.StatusCode)
	}
}

func TestReady503WhenDependencyFails(t *testing.T) {
	srv := httptest.NewServer(httpserver.New(oneFailing()))
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/health/ready")
	if err != nil {
		t.Fatalf("GET /health/ready: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("ready status = %d, want 503", resp.StatusCode)
	}

	var body readyBody
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Ready {
		t.Fatalf("ready body.ready = true, want false")
	}
	// The body must carry only names + bounded statuses, never the raw
	// error text.
	raw, _ := json.Marshal(body)
	for _, dep := range body.Dependencies {
		if dep.Dependency != "gitlab" && dep.Dependency != "database" {
			t.Fatalf("unexpected dependency name in body: %q", dep.Dependency)
		}
	}
	if string(raw) == "" {
		t.Fatalf("empty body")
	}
	// The redacted body must not leak the probe's error message.
	if got := string(raw); len(got) > 0 {
		// Assert no secret-ish token; the failing status is "unavailable".
		for _, dep := range body.Dependencies {
			if dep.Dependency == "gitlab" && dep.Ready {
				t.Fatalf("gitlab marked ready in body, want not ready")
			}
		}
	}
}
