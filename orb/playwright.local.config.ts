// Local-only: same as playwright.config.ts, but starts Vite without a pnpm script shell.
import base from "./playwright.config";
import { defineConfig } from "@playwright/test";
const port = process.env.ORB_TEST_PORT || "1431";
export default defineConfig({ ...base, webServer: { command: `pnpm exec vite --host 127.0.0.1 --port ${port}`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false } });
