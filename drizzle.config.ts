import "dotenv/config";
import { defineConfig } from 'drizzle-kit';

function sanitize(value?: string | null): string | undefined {
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

function buildConnectionUrl(): string {
  const explicitUrl = sanitize(process.env.DATABASE_URL);
  if (explicitUrl) {
    const url = new URL(explicitUrl);
    url.searchParams.set('options', '-c search_path=public');
    url.searchParams.set('sslmode', 'require');
    return url.toString();
  }

  const host = sanitize(process.env.DB_HOST) ?? 'localhost';
  const port = Number(sanitize(process.env.DB_PORT) ?? 5432);
  const database = sanitize(process.env.DB_NAME) ?? '';
  const user = sanitize(process.env.DB_USER) ?? '';
  const password = sanitize(process.env.DB_PASS);

  const url = new URL('postgres://localhost');
  url.hostname = host;
  url.port = String(port);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user;
  }
  if (password) {
    url.password = password;
  }
  url.searchParams.set('options', '-c search_path=public');
  url.searchParams.set('sslmode', 'require');
  return url.toString();
}

export default defineConfig({
  out: './drizzle',
  schema: './src/db/schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: buildConnectionUrl(),
    ssl: {
      rejectUnauthorized: false,
    },
  },
});
