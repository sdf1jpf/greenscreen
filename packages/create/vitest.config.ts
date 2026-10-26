import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The template's tests run against the workspace's @greenscreen/worker.
export default defineConfig({
	resolve: { alias: { "@greenscreen/worker": fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)) } },
	test: { include: ["test/**/*.test.ts", "template/test/**/*.test.ts"] },
});
