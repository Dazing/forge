import { resolve } from "node:path";

// The model catalog lives with the agent runtime; sandbox mounts reference it without importing runtime code.

export const modelsPath = resolve(import.meta.dirname, "models.json");
