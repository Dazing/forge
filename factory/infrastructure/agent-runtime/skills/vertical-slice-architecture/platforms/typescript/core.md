# Vertical Slice Architecture — TypeScript core conventions (shared backbone)

These rules are dialect-independent. The web and API files specialize them with
concrete nouns and folder shapes, but the model below is the contract.
## Why this exists

The goal is **human ownership of code an agent wrote**. Two failure modes break
ownership:

- A change spreads across layers, so you can't trace one feature top-to-bottom.
- Cross-feature dependencies are invisible, so you can't tell what a change
  affects elsewhere.

VSA fixes both structurally: a capability lives in one folder (trace it in one
place), and the only outward edges are explicit imports of other features'
**public** surfaces (blast radius = import list).

## The four buckets

### 1. Slice — one capability

- A vertical cut through a single thing a user can do.
- Lives in **one flat folder**, named for the capability (`add-to-cart/`,
  `submit-signup/`, `list-products/`).
- Contains its **entry** (the binding to the outside world), its **brain** (the
  logic), local **types/validation**, and its **test** — colocated.
- **May not import another slice.** If two slices need the same thing, it goes to
  the owning feature's public surface or to `shared/` (if stateless).

### 2. Feature — a domain that owns state

- Groups related slices and **owns the state/data** they act on (a store/context
  on web, a repository on the api).
- Exposes a **narrow public `index.ts`** — the only thing other features may
  import. Internals (slices, the store) are private.
- Deep-importing past a feature's `index.ts` is a boundary violation (enforced).

### 3. Composition root — arranges, doesn't implement

- A thin shell: page, layout, router, or app bootstrap.
- **Arranges** slices and layout; mounts providers for scoped state.
- **All nesting lives here.** A 5-level-deep UI or a deep route tree is depth in
  composition roots — the slice catalog stays flat.
- Holds no business logic. If logic creeps in, extract a slice.

### 4. Shared — stateless only, forever

Allowed in `shared/`:
- **Stateless infra** — http/db clients, auth header wiring, middleware.
- **Pure utilities** — `format-currency`, date helpers; no feature logic, no I/O
  on hidden state.
- **Dumb presentational pieces** — a `<Button>`, a generic table; props in,
  markup out, no domain knowledge.

Forbidden in `shared/`:
- **State.** A cart store, a session cache, anything stateful belongs to its
  owning feature, never to `shared/`. (This is the rule that stops `shared/`
  becoming a junk drawer.)
- **Feature logic.** If it knows what a "cart" or an "invoice" is, it's not
  shared.

## Shared state: two flavors, one rule

State is always **owned by a feature** and exposed through its public surface.
The only question is *where the provider/instance mounts*:

- **App-global** (auth, cart): provider mounts near the app root.
- **Route/subtree-scoped** (a checkout flow's steps, a wizard, tabbed detail
  view): provider mounts at the **lowest composition root that covers everyone
  who needs it** — the parent page/layout. Its lifetime equals that subtree's
  lifetime, which is what keeps sub-pages consistent as you navigate between
  them. Every consumer reaches it the same way (one public hook/accessor), and
  that call is the consumer's visible dependency edge.

## The granularity gate

> If you can't write a meaningful failing test for it, it's not a slice.

- Crosses to server / shared state / real logic → **slice**.
- Pure presentation, local-only toggle → **component/helper**, not a slice.

## TDD loop (per slice)

1. **Red** — write the behavioral test for the capability first; watch it fail.
2. **Green** — implement the minimum in the slice to pass.
3. **Refactor** — clean up; tests stay green.

The test is colocated in the slice and is the **spec the human reads first** in
review. A slice without its test is incomplete.

## Dependency rules (what enforcement encodes)

1. `slice → slice`: **forbidden.**
2. `slice / feature → another feature`: only via that feature's public
   `index.ts` (no deep imports).
3. `shared → features`: **forbidden** (shared never knows about features).
4. `features / slices → shared`: allowed (shared is stateless and safe).
5. `composition root → features`: allowed; the reverse is **forbidden** (a slice
   never imports a page/router).

These are mechanical and belong in lint — see `enforcement/typescript/`.

## Review checklist (how the human keeps ownership)

- Does the change touch **one slice folder** (plus maybe a composition root to
  wire it)? If it's smeared across many, the slice boundary is wrong.
- Is there a **colocated test** that reads as the spec?
- Are the slice's **only outward edges** `shared/` and other features' public
  `index.ts`? List them — that's the blast radius.
- Did any **state or feature logic leak into `shared/`**? Move it home.
- Is new **nesting** in a composition root, not in a slice?
