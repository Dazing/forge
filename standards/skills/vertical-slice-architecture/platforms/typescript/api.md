# Vertical Slice Architecture — TypeScript API dialect (TS HTTP services)

Specializes `core.md` for TypeScript HTTP APIs (Express / Fastify / Hono / Koa /
Nest). Same four buckets, HTTP nouns. The API is the *natural* VSA case: one
endpoint ≈ one slice.

## Noun mapping

| Backbone concept | API form |
|---|---|
| Slice entry (binding) | `*.route.ts` — method + path, wires validation → handler |
| Slice brain (logic) | `*.handler.ts` — the actual use-case logic |
| Validation / local types | `*.schema.ts` — input/output (zod or similar) |
| Feature-owned state/data | `*.repository.ts` — data access lives with the feature |
| Composition root | router / app bootstrap; nesting = route prefixes |
| Shared | db/http clients, generic middleware, pure utils |

## Folder shape

```
src/
  features/
    cart/                          ← feature DOMAIN (owns cart data access)
      add-to-cart/                 ← slice = one endpoint/use-case
        add-to-cart.route.ts       ← POST /cart/items → validate → handler
        add-to-cart.handler.ts     ← brain: the use-case logic
        add-to-cart.schema.ts      ← request/response validation
        add-to-cart.test.ts        ← behavioral test (HTTP- or handler-level)
      list-cart/                   ← slice (flat sibling)
      cart.repository.ts           ← feature-owned data access (state lives here)
      cart.router.ts               ← composition root: mounts this feature's slices
      index.ts                     ← public surface (what other features may use)
    catalog/
      get-product/
      list-products/
      catalog.repository.ts
      catalog.router.ts
      index.ts
  shared/
    db/client.ts                   ← stateless infra (connection pool)
    http/error-handler.ts          ← stateless middleware
    money/format-currency.ts       ← pure utility
  app.ts                           ← root composition root: mounts feature routers
```

## What goes in each slice file

- **`add-to-cart.route.ts`** — declares method + path, runs the schema, calls the
  handler, maps the result to an HTTP response. No business logic.
- **`add-to-cart.handler.ts`** — the use-case: validates business rules, uses
  `cart.repository`, returns a plain result/DTO. Framework-agnostic where
  practical (easier to test, easier to move).
- **`add-to-cart.schema.ts`** — request and response shapes; the single source of
  truth for the endpoint's contract.

Cross-feature data goes through the **public `index.ts`** of the owning feature,
never by reaching into another feature's repository directly.

## Nesting

Route depth lives in **composition roots** (routers), not in slices. `app.ts`
mounts `cart.router` at `/cart`; `cart.router` mounts each slice's route. Nested
resources (`/cart/items/:id/notes`) are expressed by router composition, while
each underlying capability stays a flat slice folder.

## TDD walkthrough (api)

Prefer testing the slice through its HTTP contract (supertest/light server) so
the test doubles as the endpoint's spec; drop to handler-level when HTTP setup
adds no signal.

The hermetic default passes the real composed `app` to `supertest` or the
framework's inject API without binding a TCP port. Keep the real router,
middleware, schemas, handlers, error mapping, and feature composition. Use a
fixture-owned process-local database supported by the existing stack; otherwise
inject a deterministic repository implementation at the feature's existing
repository seam. A repository fake is runtime shape `host`, not `host+db`.

Intercept outbound HTTP with the project's existing network fake, MSW, or the
runtime's mock agent and fail every unhandled request. The fixture owns reset and
cleanup and requires no Docker, fixed port, or network egress. A lightweight
store does not prove production-provider queries, migrations, locking, or
transaction semantics; those require a separate real-provider compatibility
suite or are `BLOCKED`.

```ts
// add-to-cart.test.ts — RED first
test('POST /cart/items adds an item and returns 201 with the line', async () => {
  const res = await request(app).post('/cart/items').send({ productId: 'mug', qty: 1 })
  expect(res.status).toBe(201)
  expect(res.body).toMatchObject({ productId: 'mug', qty: 1 })
})

test('rejects an unknown product with 404 and adds nothing', async () => {
  const res = await request(app).post('/cart/items').send({ productId: 'nope', qty: 1 })
  expect(res.status).toBe(404)
  expect(await cartRepo.count()).toBe(0)
})

test('rejects invalid payload with 400 from the schema', async () => {
  const res = await request(app).post('/cart/items').send({ qty: -1 })
  expect(res.status).toBe(400)
})
```

Then implement `route` + `schema` + `handler` until green; refactor.

## Enforcement

Use `enforcement/typescript/eslint-boundaries.api.cjs`. Element types: `shared`, `feature`
(public `index.ts` only), `slice`, `composition-root` (routers/bootstrap). See
that file for the rule set and wiring.
