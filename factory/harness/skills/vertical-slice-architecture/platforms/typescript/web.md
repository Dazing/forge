# Vertical Slice Architecture — TypeScript web dialect (React)

Specializes `core.md` for React web UIs. Same four buckets, React nouns.

## Noun mapping

| Backbone concept | Web (React) form |
|---|---|
| Slice entry (binding) | `*.tsx` component that owns the intent and renders dumb UI |
| Slice brain (logic) | `use-*.ts` hook — server calls, state updates, optimistic/rollback |
| Feature-owned state | React Context + provider, or a store (Zustand/Redux slice) |
| Composition root | page / layout / route element; nesting lives here |
| Shared | `api/client`, pure utils, dumb presentational components |

## Folder shape

```
src/
  features/
    cart/                          ← feature DOMAIN (owns cart state)
      cart-store.ts                ← state lives here, NOT in shared
      add-to-cart/                 ← slice
        add-to-cart.tsx            ← entry: renders <Button>, owns "add THIS product"
        use-add-to-cart.ts         ← brain: calls api, optimistic update, rollback
        add-to-cart.test.tsx       ← behavioral test (the spec)
        add-to-cart.types.ts       ← local types (optional)
      remove-from-cart/            ← slice (flat sibling)
      index.ts                     ← public surface: useCart, <CartProvider>
    catalog/
      product-list/                ← slice
      product-details/             ← slice
      index.ts
  shared/
    api/client.ts                  ← stateless infra (fetch wrapper, auth headers)
    ui/button.tsx                  ← dumb presentational component
    money/format-currency.ts       ← pure utility
  routes/                          ← composition roots
    catalog/page.tsx               ← composes <ProductList/>
    checkout/
      layout.tsx                   ← mounts <CheckoutProvider> for the subtree
      shipping/page.tsx            ← composes <ShippingStep/>
      payment/page.tsx             ← composes <PaymentStep/>
```

## What goes in each slice file

- **`add-to-cart.tsx`** — renders the shared dumb `<Button>`, owns the intent
  ("on click, add *this* product"), delegates work to the hook. **No business
  logic here.**
- **`use-add-to-cart.ts`** — the vertical: takes a product, calls
  `shared/api/client`, optimistically updates `cart-store`, rolls back on
  failure. The slice's brain.
- **`add-to-cart.test.tsx`** — e.g. "clicking add puts the item in the cart";
  "if the API fails, the cart rolls back and an error shows."

A page that shows a product just renders `<AddToCart product={p} />`. The page
composes the slice; it does not know how adding works.

## Nesting & sub-pages

The **route/render tree nests as deep as you like**; the **slice catalog stays
flat**. A sub-page is a smaller composition root that pulls in the slices it
needs — it is not code nested inside its parent slice. "Reviews" under a product
page is a sibling `product-reviews` slice composed by the deeper route, not a
thing living inside `product-details`.

## Sub-pages sharing context with a parent

Route-scoped shared state (a checkout flow, a wizard, tabbed master/detail):

1. The **feature owns it** — `features/checkout/checkout-context.tsx` defines the
   Context + provider; `use-checkout.ts` is the public hook.
2. The **provider mounts at the parent composition root** —
   `routes/checkout/layout.tsx` wraps its children in `<CheckoutProvider>`.
   Because the layout stays mounted while you navigate *among its children*, the
   state persists across sub-page jumps and tears down only when you leave
   `/checkout`. **The context's lifetime = the subtree's lifetime** — that's the
   consistency guarantee, and it's structural.
3. Every step reads it **identically**: `const { ... } = useCheckout()`. No
   sub-page owns the state; all are consumers of one named hook. That
   `useCheckout()` call is the sub-page's visible dependency edge.

```
features/checkout/
  checkout-context.tsx     ← owns shared state (Context + provider)
  use-checkout.ts          ← public hook every step uses
  shipping-step/           ← slice
  payment-step/            ← slice
  review-step/             ← slice
  index.ts                 ← exports <CheckoutProvider>, useCheckout
routes/checkout/
  layout.tsx               ← <CheckoutProvider> wraps the subtree
  shipping/page.tsx        ← composes <ShippingStep/>
  payment/page.tsx         ← composes <PaymentStep/>
```

## TDD walkthrough (web)

Test the capability through its public behavior (React Testing Library +
vitest), not the hook's internals.

React Testing Library + MSW is the hermetic capability-integration default. Run
the real feature provider/store, components, hooks, router, and user interaction;
mock only the unavailable backend boundary. Configure MSW to fail unhandled
requests, reset handlers after each test, and close the server after the suite.
The FE suite never requires the BE surface or Docker to be running.

Use Playwright only when the browser executable is available in the approved
execution envelope. Start the local app through a fixture-owned command, use an
assigned port, intercept unavailable external traffic, and stop the process
after the suite. Browser or app-host unavailability is `BLOCKED`, never RED.

```tsx
// add-to-cart.test.tsx  — RED first
test('adds the product to the cart on click', async () => {
  render(<AddToCart product={mug} />, { wrapper: CartProvider })
  await userEvent.click(screen.getByRole('button', { name: /add to cart/i }))
  expect(screen.getByTestId('cart-count')).toHaveTextContent('1')
})

test('rolls back and shows an error when the API fails', async () => {
  server.use(failAddToCart())
  render(<AddToCart product={mug} />, { wrapper: CartProvider })
  await userEvent.click(screen.getByRole('button', { name: /add to cart/i }))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.getByTestId('cart-count')).toHaveTextContent('0')
})
```

Then implement `add-to-cart.tsx` + `use-add-to-cart.ts` until green; refactor.

## Enforcement

Use `enforcement/typescript/eslint-boundaries.web.cjs`. Element types map to the buckets:
`shared`, `feature` (public `index.ts` only), `slice`, `composition-root`. See
that file for the rule set and `package.json` wiring.
