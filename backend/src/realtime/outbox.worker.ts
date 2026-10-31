import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { StockGateway } from './stock.gateway';

interface OutboxRow {
  id: string;
  tenant_id: string;
  store_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
}

/**
 * Transactional Outbox: Der DB-Trigger schreibt pro Buchung ein Event in
 * app.outbox_events – in derselben Transaktion wie die Buchung. Dieser Worker
 * holt neue Events ab (LISTEN/NOTIFY wäre eine spätere Optimierung) und verteilt
 * sie per WebSocket. Ergebnis: kein Event geht verloren, keines wird doppelt geholt.
 */
@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly log = new Logger(OutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly db: DbService, private readonly gateway: StockGateway) {}

  onApplicationBootstrap() {
    const interval = Number(process.env.OUTBOX_POLL_MS ?? 250);
    this.timer = setInterval(() => void this.tick(), interval);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.running) return;                // keine überlappenden Durchläufe
    this.running = true;
    try {
      const rows = await this.db.system(async (c) =>
        (await c.query<OutboxRow>('SELECT * FROM auth.claim_outbox_events($1)', [200])).rows,
      );
      for (const r of rows) this.gateway.publish(r.tenant_id, r.store_id, r.topic, r.payload);
    } catch (err) {
      this.log.error(`Outbox-Durchlauf fehlgeschlagen: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
