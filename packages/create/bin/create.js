#!/usr/bin/env node
// npm create greenscreen@latest [directory]: copy the starter app into a new
// directory and name it after the directory.

import { cpSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function create(target) {
	const dir = resolve(target);
	if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`${target} is not empty`);
	const name = basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "greenscreen-app";
	const template = join(dirname(fileURLToPath(import.meta.url)), "..", "template");
	cpSync(template, dir, { recursive: true });
	// npm leaves dotfiles like .gitignore and .npmrc out of published
	// packages, so they ship with a leading underscore.
	for (const f of ["gitignore", "npmrc"]) renameSync(join(dir, "_" + f), join(dir, "." + f));
	const title = name.replace(/-/g, " ").toUpperCase().slice(0, 40);
	for (const f of ["package.json", "wrangler.jsonc", "README.md", "src/index.ts"]) {
		const p = join(dir, f);
		writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__TITLE__", title));
	}
	return { dir, name };
}

// Run as a command (npm links bin/ through a symlink), not imported by the tests.
const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
	const target = process.argv[2] ?? "greenscreen-app";
	try {
		const { name } = create(target);
		console.log(`Created ${name} in ${target}. Next:

  cd ${target}
  npm install
  npm run dev

Then open http://localhost:8787, or run the Go terminal against it:
  go run github.com/sdf1jpf/greenscreen/cmd/greenscreen@latest -api http://localhost:8787`);
	} catch (e) {
		console.error(`create-greenscreen: ${e.message}`);
		process.exit(1);
	}
}
