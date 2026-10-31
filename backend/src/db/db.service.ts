import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { RequestContext } from '../auth/request-context';

/**
 * Einziger Zugang zur Datenbank.
 *
 * Jede fachliche Abfrage läuft über `withTenant()`: Die Funktion öffnet eine
 * Transaktion und setzt per `set_config(..., true)` (= SET LOCAL) den Kontext,
 * den die RLS-Policies lesen. Nach COMMIT/ROLLBACK ist der Kontext weg, eine
 * wiederverwendete Pool-Verbindung trägt also nie Daten eines anderen Mandanten.
 *
 * Die Verbindung läuft als DB-Rolle `app_user` (ohne BYPASSRLS).
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
  });

  async withTenant<T>(ctx: RequestContext, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true),
                set_config('app.user_id',   $2, true),
                set_config('app.role',      $3, true),
                set_config('app.store_ids', $4, true)`,
        [ctx.tenantId, ctx.userId, ctx.role, ctx.storeIds.join(',')],
      );
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /** Nur für Login/Guard: Funktionen im Schema `auth` (SECURITY DEFINER), ohne Mandantenkontext. */
  async system<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
