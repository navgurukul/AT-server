import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { and, eq, lte, gte, sql, or, isNull, ne } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import { CalendarService } from '../calendar/calendar.service';
import { NotifyService } from './notify.service';
import {
  usersTable,
  timesheetsTable,
  leaveRequestsTable,
  orgsTable
} from '../../db/schema';

@Injectable()
export class TrackerReminderService {
  private readonly logger = new Logger(TrackerReminderService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly calendar: CalendarService,
    private readonly notify: NotifyService,
    private readonly config: ConfigService,
  ) { }

  @Cron('0 21 * * *', { timeZone: 'Asia/Kolkata' })  
  async handleDailyReminder() {
    try {
      const now = new Date();
      // Get today's date in IST format YYYY-MM-DD
      const todayStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
      const startOfDay = new Date(todayStr + "T00:00:00.000Z");
      const endOfDay = new Date(startOfDay);
      endOfDay.setUTCDate(endOfDay.getUTCDate() + 1);

      const db = this.database.connection;

      const orgs = await db.select().from(orgsTable).where(eq(orgsTable.status, 'active'));

      for (const org of orgs) {
        // Check if today is a working day
        const dayInfo = await this.calendar.getDayInfo(org.id, startOfDay);
        if (!dayInfo.isWorkingDay) {
          continue;
        }

        // Fetch employees based on exit date and employment type
        const activeUsers = await db.select().from(usersTable).where(
          and(
            eq(usersTable.orgId, org.id),
            or(
              isNull(usersTable.dateOfExit),
              gte(usersTable.dateOfExit, todayStr)
            ),
            or(
              isNull(usersTable.employmentType),
              ne(usersTable.employmentType, 'Part Time/Hourly Consultant')
            )
          )
        );

        // Fetch timesheets for today
        const timesheets = await db.select().from(timesheetsTable).where(
          and(
            eq(timesheetsTable.orgId, org.id),
            gte(timesheetsTable.workDate, startOfDay),
            sql`${timesheetsTable.workDate} < ${endOfDay}`
          )
        );

        // Fetch leave requests for today
        const leaves = await db.select().from(leaveRequestsTable).where(
          and(
            eq(leaveRequestsTable.orgId, org.id),
            sql`${leaveRequestsTable.startDate} < ${endOfDay}`,
            gte(leaveRequestsTable.endDate, startOfDay),
            or(
              eq(leaveRequestsTable.state, 'approved'),
              eq(leaveRequestsTable.state, 'pending')
            )
          )
        );

        const fullDayMissed = [];
        const partialEntry = [];

        for (const user of activeUsers) {
          const userTimesheet = timesheets.find(t => t.userId === user.id);
          const loggedHours = userTimesheet ? parseFloat((userTimesheet.totalHours as unknown as string) || '0') : 0;

          const userLeaves = leaves.filter(l => l.userId === user.id);

          let hasLeaveCoverage = userLeaves.length > 0;
          let hasPartialLeave = false;

          for (const leave of userLeaves) {
            if (leave.durationType === 'half_day' || (parseFloat((leave.hours as unknown as string) || '0') < 8 && userLeaves.length === 1)) {
              hasPartialLeave = true;
            }
          }

          if (loggedHours >= 6 || (hasLeaveCoverage && !hasPartialLeave) || (hasPartialLeave && loggedHours >= 3)) {
            continue;
          }

          if ((!userTimesheet || loggedHours < 3) && !hasLeaveCoverage) {
            fullDayMissed.push(user);
          } 
          else if ((loggedHours >= 3 && loggedHours < 6) || hasPartialLeave) {
            partialEntry.push(user);
          }
        }

        // Skip if no missed or partial entries
        if (fullDayMissed.length === 0 && partialEntry.length === 0) {
          continue;
        }

        // Chunk and send Slack messages
        const slackToken = this.config.get<string>('SLACK_BOT_TOKEN');
        const slackChannelId = this.config.get<string>('SLACK_CHANNEL_ID');

        if (slackToken && slackChannelId) {
          const slackUsers = fullDayMissed.filter(u => u.slackId);
          const slackPartialUsers = partialEntry.filter(u => u.slackId);
          
          const sendChunkedSlack = async (users: typeof slackUsers, prefix: string) => {
            const chunkSize = 100;
            for (let i = 0; i < users.length; i += chunkSize) {
              const chunk = users.slice(i, i + chunkSize);
              let message = i === 0 ? prefix : "\n";
              message += chunk.map(u => `<@${u.slackId}>`).join(", ");
              await this.notify.sendSlackMessage(slackToken, slackChannelId, message);
            }
          };

          if (slackUsers.length > 0) {
            await sendChunkedSlack(slackUsers, "Following people have not filled entries or applied for leave today:\n");
          }
          if (slackPartialUsers.length > 0) {
            await sendChunkedSlack(slackPartialUsers, "Following people have filled a partial entry or leave for today:\n");
          }
          if (slackUsers.length > 0 || slackPartialUsers.length > 0) {
            this.logger.log(`Sent Slack reminders for org ${org.id}`);
          }
        } else {
          this.logger.warn(`Could not send Slack reminder. Missing token or channel ID.`);
        }

        // Chunk and send Discord messages via Webhook
        const discordWebhook = this.config.get<string>('DISCORD_WEBHOOK');

        if (discordWebhook) {
          const discordUsers = fullDayMissed.filter(u => u.discordId);
          const discordPartialUsers = partialEntry.filter(u => u.discordId);

          const sendDiscordMessage = async (message: string) => {
            await this.notify.sendDiscordMessage(discordWebhook, message);
          };

          const sendChunkedDiscord = async (users: typeof discordUsers, prefix: string) => {
            const chunkSize = 50; 
            for (let i = 0; i < users.length; i += chunkSize) {
              const chunk = users.slice(i, i + chunkSize);
              let message = i === 0 ? prefix : "\n";
              message += chunk.map(u => `<@${u.discordId}>`).join(", ");
              await sendDiscordMessage(message);
            }
          };

          if (discordUsers.length > 0) {
            await sendChunkedDiscord(discordUsers, "Following people have not filled entries or applied for leave today:\n");
          }
          if (discordPartialUsers.length > 0) {
            await sendChunkedDiscord(discordPartialUsers, "Following people have filled a partial entry or leave for today:\n");
          }
          if (discordUsers.length > 0 || discordPartialUsers.length > 0) {
            this.logger.log(`Sent Discord reminders via Webhook for org ${org.id}`);
          }
        } else {
          this.logger.warn(`Could not send Discord reminder. Missing webhook URL.`);
        }
      }
    } catch (error) {
      this.logger.error(`Error in daily tracker reminder: ${error instanceof Error ? error.message : error}`);
    }
  }
}
