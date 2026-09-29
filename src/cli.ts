#!/usr/bin/env node
// The `wuapi` command. See `wuapi help` and https://wuapi.dev/docs#cli.
import { nodeIo } from "./io.js";
import { main } from "./main.js";

const code = await main(process.argv.slice(2), nodeIo());
process.exitCode = code;
