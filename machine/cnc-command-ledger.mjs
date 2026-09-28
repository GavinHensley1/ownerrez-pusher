import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_ENTRIES = 200;
const TERMINAL = new Set(["ready", "done", "error", "stopped", "uncertain"]);

const cleanEntry = (raw) => ({
  id: String(raw?.id || "").slice(0, 160),
  action: String(raw?.action || "").slice(0, 48),
  status: String(raw?.status || "").slice(0, 24),
  message: String(raw?.message || "").slice(0, 500),
  claimedAt: String(raw?.claimedAt || ""),
  updatedAt: String(raw?.updatedAt || raw?.claimedAt || ""),
});

export function readCommandLedger(path) {
  if (!existsSync(path)) return { version: 1, entries: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw?.version !== 1 || !Array.isArray(raw.entries)) throw new Error("CNC command ledger is invalid");
  return { version: 1, entries: raw.entries.map(cleanEntry).filter((entry) => entry.id).slice(-MAX_ENTRIES) };
}

function writeCommandLedger(path, ledger) {
  const value = { version: 1, entries: ledger.entries.map(cleanEntry).filter((entry) => entry.id).slice(-MAX_ENTRIES) };
  const temp = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return value;
}

export function claimCommand(path, command, now = new Date().toISOString()) {
  const ledger = readCommandLedger(path), id = String(command?.id || "");
  if (!id) throw new Error("CNC command ID is required");
  const existing = ledger.entries.find((entry) => entry.id === id);
  if (existing) return { claimed: false, entry: existing, terminal: TERMINAL.has(existing.status) };
  const entry = cleanEntry({ id, action: command.action, status: "inflight", message: "Command claimed before execution", claimedAt: now, updatedAt: now });
  ledger.entries.push(entry);
  writeCommandLedger(path, ledger);
  return { claimed: true, entry, terminal: false };
}

export function completeCommand(path, id, status, message, now = new Date().toISOString()) {
  if (!TERMINAL.has(String(status))) throw new Error(`CNC command ledger cannot store non-terminal status ${status}`);
  const ledger = readCommandLedger(path), entry = ledger.entries.find((item) => item.id === String(id));
  if (!entry) throw new Error("CNC command was not claimed");
  Object.assign(entry, { status: String(status), message: String(message || "").slice(0, 500), updatedAt: now });
  writeCommandLedger(path, ledger);
  return cleanEntry(entry);
}
