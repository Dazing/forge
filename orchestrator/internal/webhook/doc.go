// Package webhook owns the raw-body receive path for GitLab and publisher
// webhooks: signature/authentication, replay protection, and durable receipt
// into the webhook_delivery table before any fan-out. It stores bounded
// payload references, never raw transcript material.
//
// This is a Phase 0 placeholder package boundary; its concrete logic lands in
// a later phase. It must not import sibling module packages.
package webhook
