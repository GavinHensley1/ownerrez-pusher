import { gunzipSync } from "node:zlib";

export function decodeProgram(command, limits = {}) {
  if (!command?.gcodeGzip) return String(command?.gcode || "");
  const maxPacked = Number(limits.maxPackedBytes) || 3_000_000;
  const maxOutput = Number(limits.maxOutputBytes) || 30_000_000;
  const packed = Buffer.from(String(command.gcodeGzip), "base64");
  if (!packed.length || packed.length > maxPacked) throw new Error("Compressed CNC program is invalid or too large");
  let text;
  try { text = gunzipSync(packed, { maxOutputLength: maxOutput }).toString("utf8"); }
  catch (error) { throw new Error(`Compressed CNC program could not be expanded: ${error.message}`); }
  if (!text || text.length > maxOutput) throw new Error("Expanded CNC program is invalid or too large");
  return text;
}
