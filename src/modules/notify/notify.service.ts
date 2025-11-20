import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { and, asc, desc, eq } from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import { notificationsTable } from "../../db/schema";

@Injectable()
export class NotifyService {
  private readonly logger = new Logger(NotifyService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly configService: ConfigService
  ) {}

  async previewTemplate(template: string, payload: Record<string, unknown>) {
    return {
      rendered: `Preview of ${template}`,
      payload,
    };
  }

  async dispatchPendingSlack(limit = 50) {
    const db = this.database.connection;
    const token = this.configService.get<string>("SLACK_BOT_TOKEN");
    if (!token) {
      throw new Error("SLACK_BOT_TOKEN not configured");
    }

    const pending = await db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.channel, "slack"),
          eq(notificationsTable.state, "pending")
        )
      )
      .orderBy(asc(notificationsTable.createdAt))
      .limit(limit);

    const results: Array<{
      id: number;
      status: "sent" | "error";
      errorText?: string;
    }> = [];

    for (const notification of pending) {
      const channelId = (notification.toRef as any)?.channelId;
      if (!channelId) {
        await db
          .update(notificationsTable)
          .set({
            state: "error",
            errorText: "Missing channelId in to_ref",
            attempts: (notification.attempts ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(notificationsTable.id, notification.id));
        results.push({ id: notification.id, status: "error", errorText: "Missing channelId" });
        continue;
      }

      const text = this.renderSlackText(notification.template, (notification.payload as Record<string, unknown>) ?? {});
      const ok = await this.sendSlackMessage(token, channelId, text);

      if (ok) {
        await db
          .update(notificationsTable)
          .set({
            state: "sent",
            sentAt: new Date(),
            updatedAt: new Date(),
            attempts: (notification.attempts ?? 0) + 1,
          })
          .where(eq(notificationsTable.id, notification.id));
        results.push({ id: notification.id, status: "sent" });
      } else {
        await db
          .update(notificationsTable)
          .set({
            state: "error",
            errorText: "Slack API call failed",
            attempts: (notification.attempts ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(notificationsTable.id, notification.id));
        results.push({ id: notification.id, status: "error", errorText: "Slack API call failed" });
      }
    }

    return { processed: results.length, results };
  }

  private renderSlackText(template: string, payload: Record<string, unknown>): string {
    switch (template) {
      case "timesheet_entry": {
        const userName = payload["userName"] ?? payload["userId"];
        const workDate = payload["workDateFormatted"] ?? payload["workDate"];
        const hours = payload["hours"];
        const projectName = payload["projectName"] ?? payload["projectId"];
        const desc = payload["description"] ? ` | ${payload["description"]}` : "";
        return `Timesheet: ${userName} logged ${hours}h on ${workDate} for ${projectName}${desc}`;
      }
      case "leave_request": {
        const start = payload["startDate"];
        const end = payload["endDate"];
        const durationType = payload["durationType"];
        return `Leave request: ${durationType} from ${start} to ${end}`;
      }
      default:
        return `Notification: ${template}`;
    }
  }

  private async sendSlackMessage(token: string, channelId: string, text: string): Promise<boolean> {
    try {
      const resp = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          channel: channelId,
          text,
        }),
      });
      const json = await resp.json();
      if (!json.ok) {
        this.logger.warn(`Slack API error: ${json.error ?? "unknown"}`);
      }
      return !!json.ok;
    } catch (err) {
      this.logger.error(`Slack send failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }
}
