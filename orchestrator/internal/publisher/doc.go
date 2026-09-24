// Package publisher is the client for the trusted publisher Unix-socket
// channel: it requests image builds/registrations for qualifying release
// candidates and records the digest on the release_candidate row. It talks
// to the publisher over the configured socket only.
//
// This is a Phase 0 placeholder package boundary; its concrete logic lands in
// a later phase. It must not import sibling module packages.
package publisher
