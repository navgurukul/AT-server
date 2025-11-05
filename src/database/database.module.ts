import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolConfig } from 'pg';

import { DRIZZLE } from './database.constants';
import { DatabaseService } from './database.service';
import { createDrizzleClient } from './drizzle.provider';

function sanitize(value: string | undefined | null): string | undefined {
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

@Global()
@Module({
  providers: [
    {
      provide: Pool,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const rawConnectionString = sanitize(
          configService.get<string>('DATABASE_URL'),
        );
        if (!rawConnectionString) {
          throw new Error('DATABASE_URL environment variable is required');
        }

        const url = new URL(rawConnectionString);
        url.searchParams.set('options', '-c search_path=public');

        const sslMode = (
          sanitize(configService.get<string>('DB_SSL_MODE')) ?? 'require'
        ).toLowerCase();

        const poolConfig: PoolConfig = {
          connectionString: url.toString(),
        };

        url.searchParams.delete('sslmode');
        poolConfig.connectionString = url.toString();
        poolConfig.ssl = ['require', 'verify-full', 'prefer', 'allow', 'true'].includes(
          sslMode,
        )
          ? { rejectUnauthorized: false }
          : false;

        return new Pool(poolConfig);
      },
    },
    {
      provide: DRIZZLE,
      inject: [Pool],
      useFactory: createDrizzleClient,
    },
    DatabaseService,
  ],
  exports: [Pool, DRIZZLE, DatabaseService],
})
export class DatabaseModule {}
