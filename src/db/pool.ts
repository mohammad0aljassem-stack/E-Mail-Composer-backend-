import pg from "pg";

/**
 * Minimal query surface the repositories depend on. Both `pg.Pool` and a
 * pooled client satisfy it, and it keeps repositories unit-testable with a fake
 * that records SQL. Network calls are always kept OUTSIDE long DB transactions
 * (see the send worker), so repositories expose small, single-statement ops.
 */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface Database extends Queryable {
  /** Run `fn` inside a transaction on a dedicated client. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export class PgDatabase implements Database {
  private readonly pool: pg.Pool;

  public constructor(options: { connectionString: string; max?: number }) {
    // pg parses bigint (int8) to string by default; keep that — repositories
    // convert to BigInt explicitly so we never lose precision.
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.max ?? 5,
      application_name: "transport_worker",
    });
  }

  public async query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>> {
    return this.pool.query<R>(text, values as unknown[] | undefined);
  }

  public async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  public async end(): Promise<void> {
    await this.pool.end();
  }
}
