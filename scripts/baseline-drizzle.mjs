import 'dotenv/config';
import { Client } from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';

function sanitize(value) {
  if (!value) {
    return undefined;
  }
  let trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildConnectionConfig() {
  const explicitUrl = sanitize(process.env.DATABASE_URL);
  const sslMode = (sanitize(process.env.DB_SSL_MODE) ?? 'require').toLowerCase();
  const requiresSsl = ['require', 'verify-full', 'prefer', 'allow', 'true'].includes(sslMode);

  if (explicitUrl) {
    const url = new URL(explicitUrl);
    url.searchParams.set('options', '-c search_path=navtrack,public,main');
    url.searchParams.delete('sslmode');
    return {
      connectionString: url.toString(),
      ssl: requiresSsl ? { rejectUnauthorized: false } : false,
    };
  }

  const host = sanitize(process.env.DB_HOST);
  const user = sanitize(process.env.DB_USER);
  const database = sanitize(process.env.DB_NAME);

  if (host && user && database) {
    return {
      host,
      port: Number(sanitize(process.env.DB_PORT) ?? 5432),
      user,
      password: sanitize(process.env.DB_PASS),
      database,
      ssl: requiresSsl ? { rejectUnauthorized: false } : false,
    };
  }

  throw new Error('Database connection details are missing');
}

async function main() {
  const client = new Client(buildConnectionConfig());

  await client.connect();
  await client.query('SET search_path TO navtrack, public, main');

  await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL UNIQUE,
      created_at bigint NOT NULL
    )
  `);

  const migrations = readMigrationFiles({
    migrationsFolder: './drizzle',
  });

  for (const migration of migrations) {
    const existsResult = await client.query(
      'SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1',
      [migration.hash],
    );

    if (existsResult.rowCount === 0) {
      await client.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [migration.hash, migration.folderMillis],
      );
    }
  }

  await client.end();
  console.log('Drizzle migrations baseline has been recorded.');
}

main().catch((error) => {
  console.error('Failed to baseline migrations:', error);
  process.exitCode = 1;
});
