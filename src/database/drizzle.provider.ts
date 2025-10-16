import { NodePgDatabase, drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { schema } from '../db/schema';

export type DrizzleDatabase = NodePgDatabase<typeof schema>;

export const createDrizzleClient = (pool: Pool): DrizzleDatabase =>
  drizzle(pool, { schema });
