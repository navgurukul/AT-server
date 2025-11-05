import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

const host = process.env.DB_HOST ?? 'localhost';
const port = Number(process.env.DB_PORT ?? 5432);
const database = process.env.DB_NAME ?? '';
const user = process.env.DB_USER ?? '';
const password = process.env.DB_PASS ?? undefined;

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    host,
    port,
    user,
    password,
    database,
    ssl: {
      rejectUnauthorized: false,
    },
  },
});
