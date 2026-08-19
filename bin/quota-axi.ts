#!/usr/bin/env node
import { tryFastPath } from "axi-sdk-js/fast-path";
// Leaf module: imports node builtins only, so a bare version flag never pulls
// in the provider/command graph. Any other argv falls through to the full CLI.
import { VERSION } from "../src/version.js";

if (!tryFastPath(process.argv.slice(2), { version: VERSION })) {
  const { main } = await import("../src/cli.js");
  await main();
}
