import type { ManeuverKind } from "../app/game/maneuvers";
export const PROTOCOL_VERSION = 2;
export const TICK_SECONDS = 1 / 60;
export const INPUT_SECONDS = 1 / 30;
export const MAX_DATAGRAM = 1100;
export const MAX_RELIABLE = 128 * 1024;
export type Controls = {
  seq: number;
  x: number;
  y: number;
  fire: boolean;
  boost: boolean;
  brake: boolean;
  sideways: boolean;
  maneuver: ManeuverKind | null;
  direction: -1 | 1;
};
export const neutralControls = (seq = 0): Controls => ({
  seq,
  x: 0,
  y: 0,
  fire: false,
  boost: false,
  brake: false,
  sideways: false,
  maneuver: null,
  direction: 1,
});
export function validControls(value: unknown): value is Controls {
  if (!value || typeof value !== "object") return false;
  const v = value as Controls;
  return (
    Number.isSafeInteger(v.seq) &&
    v.seq > 0 &&
    v.seq <= 0xffffffff &&
    Number.isFinite(v.x) &&
    Math.abs(v.x) <= 1 &&
    Number.isFinite(v.y) &&
    Math.abs(v.y) <= 1 &&
    [v.fire, v.boost, v.brake, v.sideways].every(
      (x) => typeof x === "boolean",
    ) &&
    [null, "barrelRoll", "somersault", "uturn"].includes(v.maneuver) &&
    (v.direction === -1 || v.direction === 1)
  );
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export function encode(value: unknown) {
  return encoder.encode(JSON.stringify(value));
}
export function decode(bytes: Uint8Array, limit = MAX_RELIABLE): unknown {
  if (bytes.byteLength > limit) throw new Error("Message too large");
  return JSON.parse(decoder.decode(bytes));
}
/** 12-byte header + byte chunks; works even when a UTF-8 character crosses packets. */
export function snapshotPackets(
  tick: number,
  value: unknown,
  maxSize = MAX_DATAGRAM,
) {
  const body = encode(value);
  const size = Math.min(MAX_DATAGRAM, maxSize) - 12;
  const count = Math.ceil(body.length / size);
  if (size < 128 || count > 128) throw new Error("Snapshot exceeds budget");
  return Array.from({ length: count }, (_, index) => {
    const part = body.subarray(index * size, (index + 1) * size);
    const packet = new Uint8Array(12 + part.length);
    const header = new DataView(packet.buffer);
    header.setUint32(0, PROTOCOL_VERSION);
    header.setUint32(4, tick);
    header.setUint16(8, index);
    header.setUint16(10, count);
    packet.set(part, 12);
    return packet;
  });
}
export class SnapshotAssembler {
  private tick = -1;
  private completed = -1;
  private started = 0;
  private parts = new Map<number, Uint8Array>();
  private count = 0;
  accept(packet: Uint8Array, now = performance.now()): unknown | null {
    if (packet.length < 12 || packet.length > MAX_DATAGRAM) return null;
    const h = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const tick = h.getUint32(4),
      index = h.getUint16(8),
      count = h.getUint16(10);
    if (
      h.getUint32(0) !== PROTOCOL_VERSION ||
      count < 1 ||
      count > 128 ||
      index >= count ||
      tick <= this.completed ||
      tick < this.tick
    )
      return null;
    if (tick > this.tick) {
      this.tick = tick;
      this.parts.clear();
      this.count = count;
      this.started = now;
    }
    if (now - this.started > 250 || count !== this.count) return null;
    this.parts.set(index, packet.slice(12));
    if (this.parts.size !== count) return null;
    const bytes = new Uint8Array(
      [...this.parts.values()].reduce((n, x) => n + x.length, 0),
    );
    let offset = 0;
    for (let i = 0; i < count; i++) {
      const part = this.parts.get(i)!;
      bytes.set(part, offset);
      offset += part.length;
    }
    this.completed = tick;
    this.parts.clear();
    try {
      return decode(bytes, 128 * MAX_DATAGRAM);
    } catch {
      return null;
    }
  }
}
/** Newline framing is bounded across arbitrary stream fragmentation. */
export class MessageFramer {
  private pending = new Uint8Array(0);
  push(chunk: Uint8Array): unknown[] {
    if (chunk.length + this.pending.length > MAX_RELIABLE * 2)
      throw new Error("Reliable queue exceeded");
    const bytes = new Uint8Array(this.pending.length + chunk.length);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.length);
    const messages: unknown[] = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++)
      if (bytes[i] === 10) {
        messages.push(decode(bytes.subarray(start, i)));
        start = i + 1;
      }
    this.pending = bytes.slice(start);
    if (this.pending.length > MAX_RELIABLE)
      throw new Error("Reliable frame exceeded");
    return messages;
  }
}
export function reliableMessage(value: unknown) {
  const bytes = encode(value);
  if (bytes.length >= MAX_RELIABLE) throw new Error("Reliable frame exceeded");
  const result = new Uint8Array(bytes.length + 1);
  result.set(bytes);
  result[bytes.length] = 10;
  return result;
}
