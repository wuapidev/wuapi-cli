import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("reads positionals, values, booleans, = and --", () => {
    const p = parseArgs(["messages", "list", "--limit", "5", "--json", "--accountId=acc_1", "--n", "-3", "--flag", "--", "--not-a-flag"]);
    expect(p.positionals).toEqual(["messages", "list", "--not-a-flag"]);
    expect(Object.fromEntries(p.flags)).toEqual({ limit: "5", json: true, accountId: "acc_1", n: "-3", flag: true });
    expect(Object.fromEntries(parseArgs(["-h", "--wait", "x"]).flags)).toEqual({ help: true, wait: true });
  });
});
