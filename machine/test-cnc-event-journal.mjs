import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendCncEvent } from "./cnc-event-journal.mjs";

test("journal records machine events privately without credential or G-code fields", () => {
  const path = join(mkdtempSync(join(tmpdir(), "cnc-events-")), "events.jsonl");
  appendCncEvent(path, "probe.failed", { message: "no contact", gcode: "G0 X0", password: "bad", position: { X: 1, Y: 2, Z: 3 } }, "2026-09-27T12:00:00.000Z");
  const text = readFileSync(path, "utf8");
  assert.match(text, /probe\.failed/);
  assert.match(text, /no contact/);
  assert.doesNotMatch(text, /G0 X0|bad/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
