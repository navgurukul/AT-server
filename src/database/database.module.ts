import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

import { DRIZZLE } from './database.constants';
import { DatabaseService } from './database.service';
import { createDrizzleClient } from './drizzle.provider';

@Global()
@Module({
  providers: [
    {
      provide: Pool,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const connectionString = configService.get<string>('DATABASE_URL');
        if (!connectionString) {
          throw new Error('DATABASE_URL environment variable is required');
        }

        const isProduction = configService.get<string>('NODE_ENV') === 'production';

        return new Pool({
          connectionString,
          ssl: isProduction
            ? {
                rejectUnauthorized: false,
              }
            : undefined,
        });
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
