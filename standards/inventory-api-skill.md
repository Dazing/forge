---
name: inventory-api
summary: Reviewed implementation standard for the controlled .NET inventory proof repository.
---

# Inventory API standard

Use capability-oriented code with business transitions expressed once and tested through observable outcomes. Reservation states are `Pending`, `Confirmed`, and `Cancelled`. Only pending reservations may be confirmed or cancelled. Reject duplicate terminal transitions without changing stock. Check and mutate stock in one critical section. Use ordinal-ignore-case SKU identity and stable uppercase representations. Preserve cancellation tokens at asynchronous boundaries. Do not add external services, databases, credentials, retry loops, or compatibility shims.
