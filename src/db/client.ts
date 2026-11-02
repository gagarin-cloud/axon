import postgres from "postgres";

export type Sql = postgres.Sql;
/** A connection or an open transaction: what a query helper needs. */
export type Tx = postgres.Sql | postgres.TransactionSql;

/**
 * Returns the URL of a sibling database `<name>_<suffix>` on the same server, creating it if needed.
 * Used to give tests and evals a scratch database that never touches real memories.
 */
export async function siblingDatabase(databaseUrl: string, suffix: string): Promise<string> {
  const url = new URL(databaseUrl);
  const name = `${url.pathname.slice(1) || "postgres"}_${suffix}`;
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name ${name}`);
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
  } catch (err) {
    if ((err as { code?: string }).code !== "42P04") throw err; // already exists
  } finally {
    await admin.end();
  }
  url.pathname = `/${name}`;
  return url.toString();
}

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 10,
    onnotice: () => {},
    transform: postgres.camel,
    // bigint ids and counts come back as strings by default; ours stay far below 2^53.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
    },
  });
}
