#!/usr/bin/env node
import { runCli } from "../dist/cli.js";

runCli().catch((err) => {
  console.error("\x1b[31mError:\x1b[0m", err);
  process.exit(1);
});
