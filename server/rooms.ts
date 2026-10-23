import { randomBytes, randomUUID } from "node:crypto";
import { Simulation } from "../shared/simulation";
export const opaque = () => randomBytes(32).toString("base64url");
export class AdmissionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Slot = {
  id: string;
  callsign: string;
  token: string;
  expires: number;
  connected: boolean;
  generation: number;
};
export type Room = {
  id: string;
  invite: string | null;
  squad: string;
  sim: Simulation;
  slots: Map<string, Slot>;
  startedAt: Date;
};
type Ticket = {
  token: string;
  room: Room;
  slot: Slot;
  origin: string;
  expires: number;
};
export type MatchResult = {
  id: string;
  seed: number;
  squad: string;
  private: boolean;
  status: "active" | "completed" | "interrupted";
  startedAt: Date;
  endedAt: Date | null;
  score: number;
  wave: number;
  participants: { id: string; callsign: string; kills: number }[];
};
export class Rooms {
  room: Room | null = null;
  draining = false;
  private tickets = new Map<string, Ticket>();
  private rates = new Map<string, { count: number; until: number }>();
  constructor(
    private persist: (result: MatchResult) => void = () => {},
    private now: () => number = Date.now,
  ) {}
  rateLimit(key: string) {
    const now = this.now();
    const rate = this.rates.get(key);
    if (rate && rate.until > now) {
      if (++rate.count > 20)
        throw new AdmissionError(
          429,
          "Too many requests. Try again in a minute.",
        );
    } else {
      if (this.rates.size >= 4096) {
        for (const [k, v] of this.rates)
          if (v.until <= now) this.rates.delete(k);
        if (this.rates.size >= 4096)
          throw new AdmissionError(503, "Admission busy. Try again shortly.");
      }
      this.rates.set(key, { count: 1, until: now + 60000 });
    }
  }
  admission(
    body: {
      action?: unknown;
      callsign?: unknown;
      squad?: unknown;
      invite?: unknown;
      reconnect?: unknown;
    },
    origin: string,
  ) {
    this.sweep();
    if (this.draining)
      throw new AdmissionError(
        503,
        "Server restarting. Please try again shortly.",
      );
    if (
      !["quick", "private", "invite", "reconnect"].includes(String(body.action))
    )
      throw new AdmissionError(400, "Unknown admission action");
    const callsign =
      typeof body.callsign === "string" ? body.callsign.trim() : "";
    if (!/^[\p{L}\p{N} _-]{1,20}$/u.test(callsign))
      throw new AdmissionError(
        400,
        "Use a callsign of 1–20 letters, numbers, spaces, _ or -.",
      );
    let room = this.room;
    let slot: Slot | undefined;
    if (body.action === "reconnect") {
      slot =
        room && typeof body.reconnect === "string"
          ? room.slots.get(body.reconnect)
          : undefined;
      if (!slot || slot.connected || slot.expires <= this.now())
        throw new AdmissionError(
          410,
          "Reconnect reservation expired or already connected.",
        );
    } else if (body.action === "invite") {
      if (
        !room ||
        typeof body.invite !== "string" ||
        room.invite !== body.invite
      )
        throw new AdmissionError(404, "Invite room is unavailable.");
    } else if (body.action === "private") {
      if (room)
        throw new AdmissionError(
          409,
          "Server full. One squad is already flying; try again later.",
        );
    } else if (room?.invite)
      throw new AdmissionError(
        409,
        "Server full. A private squad is already flying; try again later.",
      );
    if (!room) {
      const squad =
        typeof body.squad === "string" &&
        /^[\p{L}\p{N} _-]{1,24}$/u.test(body.squad.trim())
          ? body.squad.trim()
          : "Rogue Squadron";
      room = this.room = {
        id: randomUUID(),
        squad,
        invite: body.action === "private" ? opaque() : null,
        sim: new Simulation(randomBytes(4).readUInt32LE()),
        slots: new Map(),
        startedAt: new Date(this.now()),
      };
      this.persist(this.result(room, "active"));
    }
    if (!slot) {
      if (room.slots.size >= 4)
        throw new AdmissionError(
          409,
          "Squad full. All four pilot slots are occupied or reserved.",
        );
      slot = {
        id: randomUUID(),
        callsign,
        token: opaque(),
        expires: this.now() + 15000,
        connected: false,
        generation: 0,
      };
      room.slots.set(slot.token, slot);
    }
    // Only one outstanding, single-use ticket per slot; reconnect cannot extend a reservation.
    for (const [key, t] of this.tickets)
      if (t.slot === slot) this.tickets.delete(key);
    const token = opaque();
    this.tickets.set(token, {
      token,
      room,
      slot,
      origin,
      expires: Math.min(slot.expires, this.now() + 10000),
    });
    return {
      ticket: token,
      reconnect: slot.token,
      room: room.id,
      squad: room.squad,
      invite: room.invite,
      protocol: 1,
    };
  }
  consume(token: unknown, origin: string) {
    const t = typeof token === "string" ? this.tickets.get(token) : undefined;
    if (
      !t ||
      t.origin !== origin ||
      t.expires <= this.now() ||
      t.room !== this.room ||
      this.draining ||
      t.slot.connected
    )
      throw new AdmissionError(403, "Invalid or expired transport ticket");
    this.tickets.delete(t.token);
    return t;
  }
  connect(t: Ticket) {
    if (
      t.room !== this.room ||
      t.slot.expires <= this.now() ||
      t.slot.connected
    )
      throw new AdmissionError(410, "Reservation expired");
    t.slot.connected = true;
    t.slot.expires = Infinity;
    t.slot.generation++;
    const p =
      t.room.sim.pilots.get(t.slot.id) ??
      t.room.sim.join(t.slot.id, t.slot.callsign);
    p.connected = true;
    p.input.seq = 0;
    p.ack = 0;
    return t.slot.generation;
  }
  disconnect(room: Room, slot: Slot, generation: number, leave = false) {
    if (slot.generation !== generation || room !== this.room) return;
    slot.connected = false;
    slot.expires = leave ? this.now() : this.now() + 15000;
    const p = room.sim.pilots.get(slot.id);
    if (p) p.connected = false;
    this.sweep();
  }
  sweep() {
    const now = this.now();
    for (const [key, t] of this.tickets)
      if (t.expires <= now) this.tickets.delete(key);
    const room = this.room;
    if (!room) return;
    for (const [key, slot] of room.slots)
      if (!slot.connected && slot.expires <= now) {
        room.sim.leave(slot.id);
        room.slots.delete(key);
      }
    if (room.slots.size === 0) {
      this.persist(this.result(room, "completed"));
      this.room = null;
    }
  }
  checkpoint() {
    if (this.room) this.persist(this.result(this.room, "active"));
  }
  drain() {
    this.draining = true;
    if (this.room) {
      this.persist(this.result(this.room, "interrupted"));
      this.room = null;
    }
    this.tickets.clear();
  }
  private result(room: Room, status: MatchResult["status"]): MatchResult {
    return {
      id: room.id,
      seed: room.sim.seed,
      squad: room.squad,
      private: !!room.invite,
      status,
      startedAt: room.startedAt,
      endedAt: status === "active" ? null : new Date(this.now()),
      score: room.sim.score,
      wave: room.sim.wave,
      participants: [...room.sim.participants.values()].map((x) => ({ ...x })),
    };
  }
}
