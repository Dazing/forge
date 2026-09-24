// Command factory-orchestrator is the Phase 0 composition root for the
// factory orchestrator service. It loads configuration, opens the SQLite
// database, applies migrations before readiness, and serves the liveness and
// readiness endpoints. Phase 0 owns persistence and readiness only; GitLab
// mutations, scheduling, and release execution arrive in later phases.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"factory.local/platform/orchestrator/internal/config"
	"factory.local/platform/orchestrator/internal/health"
	"factory.local/platform/orchestrator/internal/httpserver"
	"factory.local/platform/orchestrator/internal/store"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	st, err := store.Open(ctx, cfg.DatabasePath, cfg.BusyTimeout)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer st.Close()

	// Migrations run before readiness can become true. A migration failure
	// leaves the database non-migrated, so /health/ready stays 503.
	if err := st.Migrate(ctx); err != nil {
		log.Printf("migrations failed; readiness will report not-ready: %v", err)
	}

	probes := []health.Dependency{
		health.DatabaseDependency(st),
		health.GitLabDependency(cfg),
		health.PublisherDependency(cfg),
		health.WorkerDependency(cfg),
	}
	checker := health.NewChecker(probes...)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           httpserver.New(checker),
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("factory-orchestrator listening on %s", cfg.ListenAddr)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server: %v", err)
		}
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
		}
	}
}
