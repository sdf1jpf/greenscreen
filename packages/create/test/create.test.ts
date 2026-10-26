import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
// @ts-expect-error plain JavaScript
import { create } from "../bin/create.js";

it("copies the template and names the app after its directory", () => {
	const dir = join(mkdtempSync(join(tmpdir(), "gs-")), "My Till");
	const { name } = create(dir);
	expect(name).toBe("my-till");
	expect(existsSync(join(dir, ".gitignore"))).toBe(true);
	expect(existsSync(join(dir, "_gitignore"))).toBe(false);
	expect(existsSync(join(dir, ".npmrc"))).toBe(true);
	expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).name).toBe("my-till");
	expect(readFileSync(join(dir, "wrangler.jsonc"), "utf8")).toContain('"name": "my-till"');
	expect(readFileSync(join(dir, "src/index.ts"), "utf8")).toContain('title: "MY TILL"');
});

it("refuses a directory that has files", () => {
	expect(() => create(join(__dirname, ".."))).toThrow(/not empty/);
});
