import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { and, asc, desc, eq } from "drizzle-orm";

import { DatabaseService } from "../../database/database.service";
import { notificationsTable, projectsTable, usersTable } from "../../db/schema";

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

  // Cron job runs at 9:00 AM IST (3:30 AM UTC) every day
  @Cron('30 3 * * *', {
    timeZone: 'Asia/Kolkata',
  })
  async handleDailyNotificationDispatch() {
    this.logger.log('Running daily notification dispatch at 9:00 AM IST');
    try {
      const result = await this.dispatchPendingSlack(100);
      this.logger.log(`Daily dispatch completed: ${result.processed} notifications processed`);
    } catch (error) {
      this.logger.error(`Daily dispatch failed: ${error}`);
    }
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

    // Group notifications by project and channel for daily activity summaries
    const groupedByProject = new Map<string, Array<typeof pending[0]>>();
    const otherNotifications: Array<typeof pending[0]> = [];

    for (const notification of pending) {
      const payload = notification.payload as Record<string, unknown>;
      const channelId = (notification.toRef as any)?.channelId;
      
      // Group only timesheet_entry notifications by project
      if (notification.template === "timesheet_entry" && channelId) {
        const projectName = payload["projectName"] || payload["projectId"] || "Unknown";
        const key = `${projectName}_${channelId}`;
        
        if (!groupedByProject.has(key)) {
          groupedByProject.set(key, []);
        }
        groupedByProject.get(key)!.push(notification);
      } else {
        otherNotifications.push(notification);
      }
    }

    // Process grouped notifications (multiple members per project)
    for (const [key, notifications] of groupedByProject.entries()) {
      const channelId = (notifications[0].toRef as any)?.channelId;
      
      if (!channelId) {
        for (const notification of notifications) {
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
        }
        continue;
      }

      // If only one notification for this project, send as single
      if (notifications.length === 1) {
        const notification = notifications[0];
        const text = await this.renderSlackText(notification.template, (notification.payload as Record<string, unknown>) ?? {});
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
      } else {
        // Multiple members - combine into one message
        const firstPayload = notifications[0].payload as Record<string, unknown>;
        const project = firstPayload["projectName"] || firstPayload["projectId"] || "Project";
        const projectId = firstPayload["projectId"] as number;

        const members = notifications.map(n => {
          const p = n.payload as Record<string, unknown>;
          const dateResolved = this.resolveNotificationDate(p) || (p["workDateFormatted"] as string);
          const formattedDate = p["workDateFormatted"] as string || dateResolved;
          return {
            name: p["userName"] || p["userId"] || "User",
            slackId: p["userSlackId"] as string || undefined,
            email: p["userEmail"] as string || "",
            entryDate: formattedDate || undefined,
            hours: p["hours"] as number || 0,
            tasks: p["description"] ? [p["description"] as string] : [],
            date: dateResolved
          };
        });

        const combinedPayload = {
          project,
          projectId,
          members
        };

        const text = await this.renderSlackText("daily_activity_summary_multi", combinedPayload);
        const ok = await this.sendSlackMessage(token, channelId, text);

        // Update all notifications in the group
        for (const notification of notifications) {
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
      }
    }

    // Process other notifications individually
    for (const notification of otherNotifications) {
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

      const text = await this.renderSlackText(notification.template, (notification.payload as Record<string, unknown>) ?? {});
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

  async dispatchPendingDiscord(limit = 50) {
    const db = this.database.connection;
    const webhookUrlEnv = this.configService.get<string>("DISCORD_WEBHOOK_URL");

    const pending = await db
      .select()
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.channel, "discord"),
          eq(notificationsTable.state, "pending")
        )
      )
      .orderBy(asc(notificationsTable.createdAt))
      .limit(limit);

    // Check if we have any pending notifications - if none, return early
    this.logger.log(`Discord dispatch: Found ${pending.length} pending notifications`);
    if (pending.length === 0) {
      this.logger.log('Discord dispatch: No pending notifications to process');
      return { processed: 0, results: [] };
    }

    const results: Array<{
      id: number;
      status: "sent" | "error";
      errorText?: string;
    }> = [];

    // Group notifications by project and channel for daily activity summaries
    const groupedByProject = new Map<string, Array<typeof pending[0]>>();
    const otherNotifications: Array<typeof pending[0]> = [];

    for (const notification of pending) {
      const payload = notification.payload as Record<string, unknown>;
      const webhookUrl = (notification.toRef as any)?.webhookUrl || webhookUrlEnv;
      
      // Group only timesheet_entry notifications by project
      if (notification.template === "timesheet_entry" && webhookUrl) {
        const projectName = payload["projectName"] || payload["projectId"] || "Unknown";
        const key = `${projectName}_${webhookUrl}`;
        
        if (!groupedByProject.has(key)) {
          groupedByProject.set(key, []);
        }
        groupedByProject.get(key)!.push(notification);
      } else {
        otherNotifications.push(notification);
      }
    }

    // Process grouped notifications (multiple members per project)
    for (const [key, notifications] of groupedByProject.entries()) {
      const webhookUrl = (notifications[0].toRef as any)?.webhookUrl || webhookUrlEnv;
      
      if (!webhookUrl) {
        for (const notification of notifications) {
          await db
            .update(notificationsTable)
            .set({
              state: "error",
              errorText: "Missing webhookUrl in to_ref",
              attempts: (notification.attempts ?? 0) + 1,
              updatedAt: new Date(),
            })
            .where(eq(notificationsTable.id, notification.id));
          results.push({ id: notification.id, status: "error", errorText: "Missing webhookUrl" });
        }
        continue;
      }

      // If only one notification for this project, send as single
      if (notifications.length === 1) {
        const notification = notifications[0];
        const text = await this.renderDiscordText(notification.template, (notification.payload as Record<string, unknown>) ?? {});
        const ok = await this.sendDiscordMessage(webhookUrl, text);

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
              errorText: "Discord API call failed",
              attempts: (notification.attempts ?? 0) + 1,
              updatedAt: new Date(),
            })
            .where(eq(notificationsTable.id, notification.id));
          results.push({ id: notification.id, status: "error", errorText: "Discord API call failed" });
        }
      } else {
        // Multiple members - combine into one message
        const firstPayload = notifications[0].payload as Record<string, unknown>;
        const project = firstPayload["projectName"] || firstPayload["projectId"] || "Project";
        const projectId = firstPayload["projectId"] as number;

        const members = notifications.map(n => {
          const p = n.payload as Record<string, unknown>;
          const dateResolved = this.resolveNotificationDate(p) || (p["workDateFormatted"] as string);
          const formattedDate = p["workDateFormatted"] as string || dateResolved;
          return {
            name: p["userName"] || p["userId"] || "User",
            email: p["userEmail"] as string || "",
            entryDate: formattedDate || undefined,
            hours: p["hours"] as number || 0,
            tasks: p["description"] ? [p["description"] as string] : [],
            date: dateResolved
          };
        });

        const combinedPayload = {
          project,
          projectId,
          members
        };

        const text = await this.renderDiscordText("daily_activity_summary_multi", combinedPayload);
        const ok = await this.sendDiscordMessage(webhookUrl, text);

        // Update all notifications in the group
        for (const notification of notifications) {
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
                errorText: "Discord API call failed",
                attempts: (notification.attempts ?? 0) + 1,
                updatedAt: new Date(),
              })
              .where(eq(notificationsTable.id, notification.id));
            results.push({ id: notification.id, status: "error", errorText: "Discord API call failed" });
          }
        }
      }
    }

    // Process other notifications individually
    for (const notification of otherNotifications) {
      const webhookUrl = (notification.toRef as any)?.webhookUrl || webhookUrlEnv;
      if (!webhookUrl) {
        await db
          .update(notificationsTable)
          .set({
            state: "error",
            errorText: "Missing webhookUrl in to_ref",
            attempts: (notification.attempts ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(notificationsTable.id, notification.id));
        results.push({ id: notification.id, status: "error", errorText: "Missing webhookUrl" });
        continue;
      }

      const text = await this.renderDiscordText(notification.template, (notification.payload as Record<string, unknown>) ?? {});
      const ok = await this.sendDiscordMessage(webhookUrl, text);

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
            errorText: "Discord API call failed",
            attempts: (notification.attempts ?? 0) + 1,
            updatedAt: new Date(),
          })
          .where(eq(notificationsTable.id, notification.id));
        results.push({ id: notification.id, status: "error", errorText: "Discord API call failed" });
      }
    }

    return { processed: results.length, results };
  }

  private async getProjectManagerEmail(projectIdOrName: string | number): Promise<string | null> {
    const db = this.database.connection;
    
    try {
      let project;
      const normalized = typeof projectIdOrName === "string" ? projectIdOrName.trim() : projectIdOrName;
      const numericId = typeof normalized === "string" && /^\d+$/.test(normalized) ? Number(normalized) : null;
      
      if (typeof normalized === 'number' || numericId !== null) {
        // Query by project ID
        project = await db
          .select({
            managerEmail: usersTable.email,
          })
          .from(projectsTable)
          .innerJoin(usersTable, eq(projectsTable.projectManagerId, usersTable.id))
          .where(eq(projectsTable.id, (numericId ?? normalized) as number))
          .limit(1);
      } else {
        // Query by project name
        const projectName = typeof normalized === "string" ? normalized : String(normalized);
        project = await db
          .select({
            managerEmail: usersTable.email,
          })
          .from(projectsTable)
          .innerJoin(usersTable, eq(projectsTable.projectManagerId, usersTable.id))
          .where(eq(projectsTable.name, projectName))
          .limit(1);
      }
      
      return project[0]?.managerEmail || null;
    } catch (error) {
      this.logger.error(`Failed to fetch project manager email: ${error}`);
      return null;
    }
  }

  private async getProjectManagerSlackId(projectIdOrName: string | number): Promise<string | null> {
    const db = this.database.connection;
    
    try {
      let project;
      const normalized = typeof projectIdOrName === "string" ? projectIdOrName.trim() : projectIdOrName;
      const numericId = typeof normalized === "string" && /^\d+$/.test(normalized) ? Number(normalized) : null;
      
      if (typeof normalized === 'number' || numericId !== null) {
        // Query by project ID
        project = await db
          .select({
            slackId: usersTable.slackId,
            name: usersTable.name,
          })
          .from(projectsTable)
          .innerJoin(usersTable, eq(projectsTable.projectManagerId, usersTable.id))
          .where(eq(projectsTable.id, (numericId ?? normalized) as number))
          .limit(1);
      } else {
        // Query by project name
        const projectName = typeof normalized === "string" ? normalized : String(normalized);
        project = await db
          .select({
            slackId: usersTable.slackId,
            name: usersTable.name,
          })
          .from(projectsTable)
          .innerJoin(usersTable, eq(projectsTable.projectManagerId, usersTable.id))
          .where(eq(projectsTable.name, projectName))
          .limit(1);
      }
      
      if (project[0]?.slackId) {
        // Return Slack mention format
        return `<@${project[0].slackId}>`;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch project manager Slack ID: ${error}`);
      return null;
    }
  }

  private async getProjectManagerDiscordId(projectIdOrName: string | number): Promise<string | null> {
    const db = this.database.connection;
    
    try {
      let project;
      const normalized = typeof projectIdOrName === "string" ? projectIdOrName.trim() : projectIdOrName;
      const numericId = typeof normalized === "string" && /^\d+$/.test(normalized) ? Number(normalized) : null;
      
      if (typeof normalized === 'number' || numericId !== null) {
        // Query by project ID
        project = await db
          .select({
            discordId: usersTable.discordId,
            name: usersTable.name,
          })
          .from(projectsTable)
          .innerJoin(usersTable, eq(projectsTable.projectManagerId, usersTable.id))
          .where(eq(projectsTable.id, (numericId ?? normalized) as number))
          .limit(1);
      } else {
        // Query by project name
        const projectName = typeof normalized === "string" ? normalized : String(normalized);
        project = await db
          .select({
            discordId: usersTable.discordId,
            name: usersTable.name,
          })
          .from(projectsTable)
          .innerJoin(usersTable, eq(projectsTable.projectManagerId, usersTable.id))
          .where(eq(projectsTable.name, projectName))
          .limit(1);
      }
      
      if (project[0]?.discordId) {
        // Return Discord mention format
        return `<@${project[0].discordId}>`;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Failed to fetch project manager Discord ID: ${error}`);
      return null;
    }
  }

  private async renderSlackText(template: string, payload: Record<string, unknown>): Promise<string> {
    switch (template) {
      case "timesheet_entry": {
        const project = payload["projectName"] || payload["projectId"] || "Project";
        const projectId = payload["projectId"] as number;
        const name = payload["userName"] || payload["userId"] || "User";
        const email = payload["userEmail"] as string || "";
        const hours = payload["hours"] as number || 0;
        const tasks = payload["description"] ? [payload["description"] as string] : [];
        const date = this.resolveNotificationDate(payload);
        let cc = payload["cc"] as string;
        
        // Fetch project manager Slack ID if not provided
        if (!cc && (projectId || (typeof project === 'string' || typeof project === 'number'))) {
          const projectIdentifier = projectId || (typeof project === 'string' || typeof project === 'number' ? project : null);
          if (projectIdentifier) {
            cc = await this.getProjectManagerSlackId(projectIdentifier) || "";
          }
        }

        let message = `Hi ${cc || 'Manager'}, these are the entries submitted to *${project}* yesterday. Please go through these entries and approve them with a 👍 reaction or, flag any discrepancies on #help-hrms\n\n`;
        
        // Tag employee using Slack ID
        const userSlackId = payload["userSlackId"] as string;
        const entryDate = payload["workDateFormatted"] as string;
        const employeeTag = userSlackId ? `<@${userSlackId}>` : name;
        message += `👤 *${employeeTag}*\n`;
        
        // Entry date
        if (entryDate) {
          message += `📅 Date: ${entryDate}\n`;
        }
        
        // Hours
        message += `⏳ Total Hours: ${hours} hrs\n`;
        
        // Task description
        message += `📝 Tasks:\n`;
        if (tasks && tasks.length > 0) {
          tasks.forEach((task) => {
            message += `• ${task}\n`;
          });
        } else {
          message += `• No tasks reported\n`;
        }
        
        message += `\n___________________________________`;

        return message;
      }
      case "leave_request": {
        const start = payload["startDate"];
        const end = payload["endDate"];
        const durationType = payload["durationType"];
        return `Leave request: ${durationType} from ${start} to ${end}`;
      }
      case "daily_activity_summary_single": {
        const project = payload["project"] || "Project";
        const projectId = payload["projectId"] as number;
        const name = payload["name"] as string;
        const email = payload["email"] as string;
        const hours = payload["hours"] as number;
        const tasks = payload["tasks"] as string[] || [];
        const date = this.resolveNotificationDate(payload);
        let cc = payload["cc"] as string;
        
        // Fetch project manager Slack ID if not provided
        if (!cc && (projectId || (typeof project === 'string' || typeof project === 'number'))) {
          const projectIdentifier = projectId || (typeof project === 'string' || typeof project === 'number' ? project : null);
          if (projectIdentifier) {
            cc = await this.getProjectManagerSlackId(projectIdentifier) || "";
          }
        }

        let message = `Hi ${cc || 'Manager'}, these are the entries submitted to *${project}* yesterday. Please go through these entries and approve them with a 👍 reaction or, flag any discrepancies on #help-hrms\n\n`;
        
        // Tag employee using Slack ID
        const slackId = payload["slackId"] as string;
        const entryDate = payload["workDateFormatted"] as string;
        const employeeTag = slackId ? `<@${slackId}>` : name;
        message += `👤 *${employeeTag}*\n`;
        
        // Entry date
        if (entryDate) {
          message += `📅 Date: ${entryDate}\n`;
        }
        
        // Hours
        message += `⏳ Total Hours: ${hours} hrs\n`;
        
        // Task description
        message += `📝 Tasks:\n`;
        if (tasks && tasks.length > 0) {
          tasks.forEach((task) => {
            message += `• ${task}\n`;
          });
        } else {
          message += `• No tasks reported\n`;
        }
        
        message += `\n___________________________________`;

        return message;
      }
      case "daily_activity_summary_multi": {
        const project = payload["project"] || "Project";
        const projectId = payload["projectId"] as number;
        const members = payload["members"] as Array<{
          name: string;
          slackId?: string;
          email: string;
          entryDate?: string;
          hours: number;
          tasks: string[];
          date?: string | null;
        }> || [];
        let cc = payload["cc"] as string;
        
        // Fetch project manager Slack ID if not provided
        if (!cc && (projectId || (typeof project === 'string' || typeof project === 'number'))) {
          const projectIdentifier = projectId || (typeof project === 'string' || typeof project === 'number' ? project : null);
          if (projectIdentifier) {
            cc = await this.getProjectManagerSlackId(projectIdentifier) || "";
          }
        }

        let message = `Hi ${cc || 'Manager'}, these are the entries submitted to *${project}* yesterday. Please go through these entries and approve them with a 👍 reaction or, flag any discrepancies on #help-hrms\n\n`;
        
        members.forEach((member, index) => {
          // Tag employee using Slack ID
          const employeeTag = member.slackId ? `<@${member.slackId}>` : member.name;
          message += `👤 *${employeeTag}*\n`;
          
          // Entry date (with fallback)
          const displayDate = member.entryDate || member.date;
          if (displayDate) {
            message += `📅 Date: ${displayDate}\n`;
          }
          
          // Hours
          message += `⏳ Total Hours: ${member.hours} hrs\n`;
          
          // Task description
          message += `📝 Tasks:\n`;
          if (member.tasks && member.tasks.length > 0) {
            member.tasks.forEach((task) => {
              message += `• ${task}\n`;
            });
          } else {
            message += `• No tasks reported\n`;
          }
          
          // Add separator line after each member
          message += `\n___________________________________`;
          
          // Add extra spacing between members (but not after the last one)
          if (index < members.length - 1) {
            message += `\n\n`;
          }
        });
        return message;
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

  private async renderDiscordText(template: string, payload: Record<string, unknown>): Promise<string> {
    switch (template) {
      case "timesheet_entry": {
        const project = payload["projectName"] || payload["projectId"] || "Project";
        const projectId = payload["projectId"] as number;
        const name = payload["userName"] || payload["userId"] || "User";
        const email = payload["userEmail"] as string || "";
        const hours = payload["hours"] as number || 0;
        const tasks = payload["description"] ? [payload["description"] as string] : [];
        const date = this.resolveNotificationDate(payload);
        let cc = payload["cc"] as string;
        
        // Fetch project manager Discord ID if not provided
        if (!cc && (projectId || (typeof project === 'string' || typeof project === 'number'))) {
          const projectIdentifier = projectId || (typeof project === 'string' || typeof project === 'number' ? project : null);
          if (projectIdentifier) {
            cc = await this.getProjectManagerDiscordId(projectIdentifier) || "";
          }
        }

        let message = `Hi ${cc || 'Manager'}, these are the entries submitted to **${project}** yesterday. Please go through these entries and approve them with a 👍 reaction or, flag any discrepancies on #help-hrms\n\n`;
        
        // Tag employee using Discord ID
        const userDiscordId = payload["userDiscordId"] as string;
        const entryDate = payload["workDateFormatted"] as string;
        const employeeTag = userDiscordId ? `<@${userDiscordId}>` : name;
        message += `👤 **${employeeTag}**\n`;
        
        // Entry date
        if (entryDate) {
          message += `📅 Date: ${entryDate}\n`;
        }
        
        // Hours
        message += `⏳ Total Hours: ${hours} hrs\n`;
        
        // Task description
        message += `📝 Tasks:\n`;
        if (tasks && tasks.length > 0) {
          tasks.forEach((task) => {
            message += `• ${task}\n`;
          });
        } else {
          message += `• No tasks reported\n`;
        }
        
        message += `\n___________________________________`;

        return message;
      }
      case "leave_request": {
        const start = payload["startDate"];
        const end = payload["endDate"];
        const durationType = payload["durationType"];
        return `Leave request: ${durationType} from ${start} to ${end}`;
      }
      case "daily_activity_summary_single": {
        const project = payload["project"] || "Project";
        const projectId = payload["projectId"] as number;
        const name = payload["name"] as string;
        const email = payload["email"] as string;
        const hours = payload["hours"] as number;
        const tasks = payload["tasks"] as string[] || [];
        const date = this.resolveNotificationDate(payload);
        let cc = payload["cc"] as string;
        
        // Fetch project manager Discord ID if not provided
        if (!cc && (projectId || (typeof project === 'string' || typeof project === 'number'))) {
          const projectIdentifier = projectId || (typeof project === 'string' || typeof project === 'number' ? project : null);
          if (projectIdentifier) {
            cc = await this.getProjectManagerDiscordId(projectIdentifier) || "";
          }
        }

        let message = `Hi ${cc || 'Manager'}, these are the entries submitted to **${project}** yesterday. Please go through these entries and approve them with a 👍 reaction or, flag any discrepancies on #help-hrms\n\n`;
        
        // Tag employee using Discord ID
        const discordId = payload["discordId"] as string;
        const entryDate = payload["workDateFormatted"] as string;
        const employeeTag = discordId ? `<@${discordId}>` : name;
        message += `👤 **${employeeTag}**\n`;
        
        // Entry date
        if (entryDate) {
          message += `📅 Date: ${entryDate}\n`;
        }
        
        // Hours
        message += `⏳ Total Hours: ${hours} hrs\n`;
        
        // Task description
        message += `📝 Tasks:\n`;
        if (tasks && tasks.length > 0) {
          tasks.forEach((task) => {
            message += `• ${task}\n`;
          });
        } else {
          message += `• No tasks reported\n`;
        }
        
        message += `\n___________________________________`;

        return message;
      }
      case "daily_activity_summary_multi": {
        const project = payload["project"] || "Project";
        const projectId = payload["projectId"] as number;
        const members = payload["members"] as Array<{
          name: string;
          discordId?: string;
          email: string;
          entryDate?: string;
          hours: number;
          tasks: string[];
          date?: string | null;
        }> || [];
        let cc = payload["cc"] as string;
        
        // Fetch project manager Discord ID if not provided
        if (!cc && (projectId || (typeof project === 'string' || typeof project === 'number'))) {
          const projectIdentifier = projectId || (typeof project === 'string' || typeof project === 'number' ? project : null);
          if (projectIdentifier) {
            cc = await this.getProjectManagerDiscordId(projectIdentifier) || "";
          }
        }

        let message = `Hi ${cc || 'Manager'}, these are the entries submitted to **${project}** yesterday. Please go through these entries and approve them with a 👍 reaction or, flag any discrepancies on #help-hrms\n\n`;
        
        members.forEach((member, index) => {
          // Tag employee using Discord ID
          const employeeTag = member.discordId ? `<@${member.discordId}>` : member.name;
          message += `👤 **${employeeTag}**\n`;
          
          // Entry date (with fallback)
          const displayDate = member.entryDate || member.date;
          if (displayDate) {
            message += `📅 Date: ${displayDate}\n`;
          }
          
          // Hours
          message += `⏳ Total Hours: ${member.hours} hrs\n`;
          
          // Task description
          message += `📝 Tasks:\n`;
          if (member.tasks && member.tasks.length > 0) {
            member.tasks.forEach((task) => {
              message += `• ${task}\n`;
            });
          } else {
            message += `• No tasks reported\n`;
          }
          
          // Add separator line after each member
          message += `\n___________________________________`;
          
          // Add extra spacing between members (but not after the last one)
          if (index < members.length - 1) {
            message += `\n\n`;
          }
        });
        return message;
      }
      default:
        return `Notification: ${template}`;
    }
  }

  private async sendDiscordMessage(webhookUrl: string, text: string): Promise<boolean> {
    try {
      const resp = await fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          content: text,
        }),
      });
      if (!resp.ok) {
        this.logger.warn(`Discord API error: ${resp.statusText}`);
      }
      return resp.ok;
    } catch (err) {
      this.logger.error(`Discord send failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  private resolveNotificationDate(payload: Record<string, unknown>): string | null {
    const date = payload["date"] || payload["workDate"] || payload["entryDate"];
    if (date instanceof Date) {
      return date.toISOString().split('T')[0];
    }
    if (typeof date === 'string') {
      return date;
    }
    return null;
  }
}
