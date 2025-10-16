import { Inject, Injectable } from '@nestjs/common';

import { DRIZZLE } from './database.constants';
import { DrizzleDatabase } from './drizzle.provider';

@Injectable()
export class DatabaseService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDatabase) {}

  get connection() {
    return this.db;
  }
}
