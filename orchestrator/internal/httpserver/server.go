// Package httpserver wires the Phase 0 liveness and readiness HTTP handlers.
//
// GET /health/live  -> 200 when the process is up (liveness).
// GET /health/ready -> 200 when every required dependency is ready, 503
//
//	otherwise. The body lists dependency names and statuses
//	only; no secret values are ever emitted.
//
// Readiness does not trigger workflow, GitLab, or release mutations.
package httpserver

import (
	"encoding/json"
	"net/http"

	"factory.local/platform/orchestrator/internal/health"
)

// New returns the Phase 0 health handler. The checker drives readiness.
func New(checker *health.Checker) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"live"}` + "\n"))
	})

	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		results := checker.Check(r.Context())
		allReady := true
		for _, res := range results {
			if !res.Ready {
				allReady = false
				break
			}
		}
		body, _ := json.Marshal(map[string]any{
			"ready":        allReady,
			"dependencies": results,
		})
		if !allReady {
			w.WriteHeader(http.StatusServiceUnavailable)
		} else {
			w.WriteHeader(http.StatusOK)
		}
		_, _ = w.Write(body)
		_, _ = w.Write([]byte("\n"))
	})

	return mux
}
