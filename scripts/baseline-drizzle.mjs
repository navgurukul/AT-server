import 'dotenv/config';
import { Client } from 'pg';
import { readMigrationFiles } from 'drizzle-orm/migrator';

function buildConnectionConfig() {
  if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_NAME) {
    return {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASS ?? undefined,
      database: process.env.DB_NAME,
      ssl: { rejectUnauthorized: false },
    };
  }

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    };
  }

  throw new Error('Database connection details are missing');
}

async function main() {
  const client = new Client(buildConnectionConfig());

  await client.connect();

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
