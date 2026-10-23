import { PrismaClient } from "@prisma/client";
import type { MatchResult } from "./rooms";
/** Coalesced queue and bounded retries: no awaited database work in simulation ticks. */
export class Persistence {
  failures = 0;
  dropped = 0;
  private busy = false;
  private queue = new Map<string, { result: MatchResult; attempt: number }>();
  private client: PrismaClient | null;
  constructor(client?: PrismaClient | null) {
    this.client =
      client === undefined
        ? process.env.DATABASE_URL
          ? new PrismaClient()
          : null
        : client;
  }
  enqueue = (result: MatchResult) => {
    const old = this.queue.get(result.id);
    if (old && old.result.status !== "active" && result.status === "active")
      return;
    if (this.queue.size >= 64 && !old) {
      this.dropped++;
      return;
    }
    this.queue.set(result.id, { result, attempt: old?.attempt ?? 0 });
    void this.pump();
  };
  private async pump() {
    if (this.busy || !this.queue.size) return;
    this.busy = true;
    const [id, job] = this.queue.entries().next().value!;
    try {
      if (!this.client) throw new Error("Database unavailable");
      const r = job.result;
      const data = {
        mode: r.mode,
        winner: r.winner,
        seed: BigInt(r.seed),
        squad: r.squad,
        private: r.private,
        status: r.status,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        score: r.score,
        wave: r.wave,
      };
      await this.client.$transaction(
        async (tx) => {
          await tx.match.upsert({
            where: { id },
            create: { id, ...data },
            update: data,
          });
          for (const p of r.participants)
            await tx.participant.upsert({
              where: { matchId_id: { matchId: id, id: p.id } },
              create: { ...p, matchId: id },
              update: {
                callsign: p.callsign,
                kills: p.kills,
                humanKills: p.humanKills,
                deaths: p.deaths,
                points: p.points,
              },
            });
        },
        { timeout: 5000, maxWait: 1000 },
      );
      if (this.queue.get(id) === job) this.queue.delete(id);
    } catch {
      this.failures++;
      job.attempt++;
      if (job.attempt >= 5 && this.queue.get(id) === job) {
        this.queue.delete(id);
        this.dropped++;
      }
    }
    this.busy = false;
    if (this.queue.size)
      setTimeout(
        () => {
          void this.pump();
        },
        Math.min(30000, 500 * 2 ** job.attempt),
      ).unref();
  }
  async flush(timeout = 10000) {
    const until = Date.now() + timeout;
    while ((this.busy || this.queue.size) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
