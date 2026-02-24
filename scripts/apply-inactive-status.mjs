#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const { Pool } = pg;

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    const client = await pool.connect();
    
    try {
      const migrationPath = join(__dirname, '../drizzle/0022_add_inactive_project_status.sql');
      const sql = await readFile(migrationPath, 'utf-8');
      
      await client.query(sql);
      
    } finally {
      client.release();
    }
  } catch (error) {
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
