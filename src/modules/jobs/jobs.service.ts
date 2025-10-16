import { BadRequestException, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { jobsTable } from '../../db/schema';

@Injectable()
export class JobsService {
  constructor(private readonly database: DatabaseService) {}

  async listJobs(limit = 25) {
    const db = this.database.connection;
    const pageSize = Math.max(1, Math.min(limit, 100));

    return db
      .select({
        id: jobsTable.id,
        type: jobsTable.type,
        status: jobsTable.status,
        runAt: jobsTable.runAt,
        attempts: jobsTable.attempts,
        lockedBy: jobsTable.lockedBy,
        lockedAt: jobsTable.lockedAt,
        lastError: jobsTable.lastError,
        createdAt: jobsTable.createdAt,
        updatedAt: jobsTable.updatedAt,
      })
      .from(jobsTable)
      .orderBy(desc(jobsTable.createdAt), desc(jobsTable.id))
      .limit(pageSize);
  }

  async triggerJob(type: string, payload: Record<string, unknown> = {}) {
    if (!type?.trim()) {
      throw new BadRequestException('Job type is required');
    }

    const db = this.database.connection;
    const now = new Date();
    const [job] = await db
      .insert(jobsTable)
      .values({
        type: type.trim(),
        payload,
        runAt: now,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning({
        id: jobsTable.id,
        type: jobsTable.type,
        status: jobsTable.status,
        runAt: jobsTable.runAt,
        attempts: jobsTable.attempts,
      });

    return {
      enqueued: true,
      job,
    };
  }

  async markJobErrored(id: number, error: string) {
    const db = this.database.connection;
    await db
      .update(jobsTable)
      .set({
        status: 'error',
        lastError: error,
        updatedAt: new Date(),
      })
      .where(eq(jobsTable.id, id));
  }
}
