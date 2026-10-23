import { FlightDynamics } from "../../shared/flight";
import {
  advancePilot,
  restoreFlight,
  type WorldSnapshot,
} from "../../shared/simulation";
import {
  encode,
  MessageFramer,
  neutralControls,
  PROTOCOL_VERSION,
  reliableMessage,
  SnapshotAssembler,
  type Controls,
} from "../../shared/protocol";
export type ConnectionStatus =
  "connecting" | "connected" | "reconnecting" | "error" | "left";
export type CoopView = {
  status: ConnectionStatus;
  message: string;
  squad: string;
  invite: string | null;
  pilot: string;
  state: WorldSnapshot | null;
};
type Admission = {
  ticket: string;
  reconnect: string;
  room: string;
  squad: string;
  invite: string | null;
  transport: string;
};
export class CoopClient {
  readonly flight = new FlightDynamics();
  view: CoopView = {
    status: "connecting",
    message: "Requesting flight clearance…",
    squad: "",
    invite: null,
    pilot: "",
    state: null,
  };
  previous: WorldSnapshot | null = null;
  receivedAt = 0;
  private transport?: WebTransport;
  private reliable?: WritableStreamDefaultWriter<Uint8Array>;
  private datagrams?: WritableStreamDefaultWriter<Uint8Array>;
  private accumulator = 0;
  private localTick = 0;
  private seq = 0;
  private pending: Controls[] = [];
  private input = neutralControls();
  private sendBusy = false;
  private stopped = false;
  private maneuver: Controls["maneuver"] = null;
  private direction: -1 | 1 = 1;
  private reconnectToken = "";
  private callsign = "";
  private lastSnapshot = 0;
  constructor(
    readonly endpoint: string,
    private changed: (view: CoopView) => void,
  ) {}
  private publish() {
    this.changed({ ...this.view });
  }
  async join(
    action: "quick" | "private" | "invite" | "reconnect",
    callsign: string,
    squad: string,
    invite?: string,
  ) {
    this.callsign = callsign;
    if (typeof window.WebTransport !== "function" || !window.isSecureContext)
      throw new Error(
        "Co-op needs a browser with WebTransport (try current Chrome or Edge) and HTTPS. Single-player remains available.",
      );
    if (action === "reconnect")
      this.reconnectToken = sessionStorage.getItem("xwing-reconnect") ?? "";
    await this.open({
      action,
      callsign,
      squad,
      invite,
      reconnect: this.reconnectToken,
    });
  }
  private async open(body: unknown) {
    const res = await fetch(`${this.endpoint}/admission`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    const admission = (await res.json()) as Admission & { error?: string };
    if (!res.ok) throw new Error(admission.error ?? "Admission failed");
    this.reconnectToken = admission.reconnect;
    sessionStorage.setItem("xwing-reconnect", admission.reconnect);
    this.view.squad = admission.squad;
    this.view.invite = admission.invite;
    // Certificate pins are injected only by local Playwright, never by the API or production UI.
    const transport = new WebTransport(admission.transport);
    this.transport = transport;
    try {
      await Promise.race([
        transport.ready,
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(
                  "WebTransport timed out. Allow UDP 443 on your network, or choose single-player.",
                ),
              ),
            8000,
          ),
        ),
      ]);
    } catch (error) {
      transport.close();
      throw error;
    }
    const stream = await transport.createBidirectionalStream();
    this.reliable = stream.writable.getWriter();
    this.datagrams = transport.datagrams.writable.getWriter();
    await this.reliable.write(
      reliableMessage({
        type: "join",
        protocol: PROTOCOL_VERSION,
        ticket: admission.ticket,
      }),
    );
    this.seq = 0;
    this.pending = [];
    this.localTick = 0;
    this.lastSnapshot = performance.now();
    void this.readReliable(stream.readable, transport);
    void this.readSnapshots(transport);
    void transport.closed.then(
      () => this.disconnected(transport),
      () => this.disconnected(transport),
    );
    // Reliable welcome, not transport.ready, marks the game connected.
    await new Promise<void>((resolve, reject) => {
      const start = performance.now();
      const poll = () => {
        if (this.view.status === "connected") resolve();
        else if (this.stopped || performance.now() - start > 5000) {
          transport.close();
          reject(new Error("Server did not complete the join handshake."));
        } else setTimeout(poll, 25);
      };
      poll();
    });
  }
  private async readReliable(
    readable: ReadableStream<Uint8Array>,
    transport: WebTransport,
  ) {
    const reader = readable.getReader();
    const framer = new MessageFramer();
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const raw of framer.push(value)) {
          const m = raw as {
            type: string;
            protocol: number;
            pilot: string;
            state: WorldSnapshot;
            squad: string;
            invite: string | null;
            reason: string;
          };
          if (m.type === "welcome") {
            if (m.protocol !== PROTOCOL_VERSION)
              throw new Error("Server version mismatch. Refresh the page.");
            this.view = {
              ...this.view,
              pilot: m.pilot,
              squad: m.squad,
              invite: m.invite,
              status: "connected",
              message: "Connected // authoritative flight",
            };
            this.previous = null;
            this.acceptSnapshot(m.state);
            this.publish();
          } else if (m.type === "draining") {
            this.stopped = true;
            this.view.status = "error";
            this.view.message = m.reason;
            sessionStorage.removeItem("xwing-reconnect");
            this.publish();
          }
        }
      }
    } catch {
      transport.close();
    }
  }
  private async readSnapshots(transport: WebTransport) {
    const reader = transport.datagrams.readable.getReader();
    const assembler = new SnapshotAssembler();
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        const state = assembler.accept(value) as WorldSnapshot | null;
        if (state) this.acceptSnapshot(state);
      }
    } catch {
      transport.close();
    }
  }
  private acceptSnapshot(state: WorldSnapshot) {
    if (
      this.view.state &&
      state.tick <= this.view.state.tick &&
      this.view.status !== "reconnecting"
    )
      return;
    const local = state.pilots.find((p) => p.id === this.view.pilot);
    if (!local) return;
    this.previous = this.view.state;
    this.view.state = state;
    this.receivedAt = performance.now();
    this.lastSnapshot = this.receivedAt;
    restoreFlight(this.flight, local.flight);
    this.pending =
      local.hull > 0
        ? this.pending.filter((input) => input.seq > local.ack)
        : [];
    if (local.hull > 0)
      for (const input of this.pending) advancePilot(this.flight, input);
    this.publish();
  }
  update(delta: number, requested: Omit<Controls, "seq">) {
    if (requested.maneuver) {
      this.maneuver = requested.maneuver;
      this.direction = requested.direction;
    }
    if (this.view.status !== "connected" || !this.view.state) return;
    if (performance.now() - this.lastSnapshot > 4000) {
      this.transport?.close();
      return;
    }
    this.accumulator = Math.min(this.accumulator + delta, 0.1);
    while (this.accumulator >= 1 / 60) {
      this.accumulator -= 1 / 60;
      if (this.localTick++ % 2 === 0) {
        this.input = {
          ...requested,
          seq: ++this.seq,
          maneuver: this.maneuver,
          direction: this.direction,
        };
        this.maneuver = null;
        if (!this.sendBusy && this.datagrams) {
          this.sendBusy = true;
          void this.datagrams
            .write(encode({ protocol: PROTOCOL_VERSION, input: this.input }))
            .catch(() => this.transport?.close())
            .finally(() => {
              this.sendBusy = false;
            });
        }
      }
      const local = this.view.state.pilots.find(
        (p) => p.id === this.view.pilot,
      );
      if (local && local.hull > 0) {
        advancePilot(this.flight, this.input);
        this.pending.push({ ...this.input });
      }
      this.input.maneuver = null;
      if (this.pending.length > 180) {
        this.pending = [];
        this.transport?.close();
        return;
      }
    }
  }
  private async disconnected(transport: WebTransport) {
    if (
      this.stopped ||
      transport !== this.transport ||
      this.view.status === "connecting"
    )
      return;
    this.view.status = "reconnecting";
    this.view.message =
      "Signal lost. Reconnecting; your ship remains vulnerable for 15 seconds…";
    this.publish();
    const start = performance.now();
    while (!this.stopped && performance.now() - start < 14000) {
      await new Promise((r) => setTimeout(r, 750));
      try {
        await this.open({
          action: "reconnect",
          reconnect: this.reconnectToken,
          callsign: this.callsign,
        });
        return;
      } catch {
        /* Reservation may still be detaching. */
      }
    }
    if (!this.stopped) {
      this.view.status = "error";
      this.view.message =
        "Reconnect reservation expired. Leave and join a new sortie. Single-player remains available.";
      this.publish();
    }
  }
  disconnectForTest() {
    this.transport?.close();
  }
  leave() {
    this.stopped = true;
    sessionStorage.removeItem("xwing-reconnect");
    const transport = this.transport;
    if (this.reliable)
      void this.reliable
        .write(reliableMessage({ type: "leave" }))
        .catch(() => {})
        .finally(() => transport?.close());
    else transport?.close();
    this.view.status = "left";
  }
}
