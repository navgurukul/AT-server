import { Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, gte, inArray, lt } from 'drizzle-orm';

import { DatabaseService } from '../../database/database.service';
import {
  costRatesTable,
  projectsTable,
  timesheetEntriesTable,
  timesheetsTable,
  usersTable,
} from '../../db/schema';

interface CostSummaryParams {
  from?: string;
  to?: string;
}

@Injectable()
export class CostingService {
  constructor(private readonly database: DatabaseService) {}

  async getProjectCostSummary(projectId: number, params: CostSummaryParams) {
    const db = this.database.connection;

    const [project] = await db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        budgetCurrency: projectsTable.budgetCurrency,
        budgetAmountMinor: projectsTable.budgetAmountMinor,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .limit(1);

    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    const fromDate = params.from ? new Date(params.from) : undefined;
    const toDateExclusive = params.to
      ? new Date(new Date(params.to).getTime() + 24 * 60 * 60 * 1000)
      : undefined;

    const filters = [
      eq(timesheetEntriesTable.projectId, projectId),
      inArray(timesheetsTable.state, ['approved', 'locked'] as const),
    ];

    if (fromDate) {
      filters.push(gte(timesheetsTable.workDate, fromDate));
    }
    if (toDateExclusive) {
      filters.push(lt(timesheetsTable.workDate, toDateExclusive));
    }

    const entries = await db
      .select({
        timesheetId: timesheetEntriesTable.timesheetId,
        userId: timesheetsTable.userId,
        hoursDecimal: timesheetEntriesTable.hoursDecimal,
        workDate: timesheetsTable.workDate,
      })
      .from(timesheetEntriesTable)
      .innerJoin(
        timesheetsTable,
        eq(timesheetEntriesTable.timesheetId, timesheetsTable.id),
      )
      .where(and(...(filters as [typeof filters[number], ...typeof filters])));

    if (entries.length === 0) {
      return {
        projectId,
        projectName: project.name,
        window: {
          from: fromDate ?? null,
          to: params.to ? new Date(params.to) : null,
        },
        totalHours: 0,
        totalCostMinor: 0,
        budgetCurrency: project.budgetCurrency,
        budgetAmountMinor: project.budgetAmountMinor,
        budgetUtilisationPct: project.budgetAmountMinor
          ? 0
          : null,
        contributors: [],
      };
    }

    const contributors = new Map<
      number,
      { userId: number; hours: number; costMinor: number }
    >();

    for (const entry of entries) {
      const contributor =
        contributors.get(entry.userId) ??
        contributors.set(entry.userId, {
          userId: entry.userId,
          hours: 0,
          costMinor: 0,
        }).get(entry.userId)!;
      contributor.hours += Number(entry.hoursDecimal ?? 0);
    }

    const userIds = Array.from(contributors.keys());
    const costRates =
      userIds.length === 0
        ? []
        : await db
            .select({
              userId: costRatesTable.userId,
              effectiveFrom: costRatesTable.effectiveFrom,
              effectiveTo: costRatesTable.effectiveTo,
              hourlyCostMinor: costRatesTable.hourlyCostMinor,
            })
            .from(costRatesTable)
            .where(inArray(costRatesTable.userId, userIds));

    const costRatesByUser = costRates.reduce<
      Record<
        number,
        {
          effectiveFrom: Date | null;
          effectiveTo: Date | null;
          hourlyCostMinor: number;
        }[]
      >
    >((acc, curr) => {
      if (!acc[curr.userId]) {
        acc[curr.userId] = [];
      }
      acc[curr.userId].push({
        effectiveFrom: curr.effectiveFrom ? new Date(curr.effectiveFrom) : null,
        effectiveTo: curr.effectiveTo ? new Date(curr.effectiveTo) : null,
        hourlyCostMinor: curr.hourlyCostMinor ?? 0,
      });
      return acc;
    }, {});

    const totalCostMinor = entries.reduce((acc, entry) => {
      const rateOptions = costRatesByUser[entry.userId] ?? [];
      const entryDate = new Date(entry.workDate);
      const matchingRate = rateOptions.find((rate) => {
        const startOk =
          !rate.effectiveFrom || rate.effectiveFrom <= entryDate;
        const endOk =
          !rate.effectiveTo || rate.effectiveTo >= entryDate;
        return startOk && endOk;
      });
      const hourlyCost = matchingRate?.hourlyCostMinor ?? 0;
      const cost = Number(entry.hoursDecimal ?? 0) * hourlyCost;
      const contributor = contributors.get(entry.userId);
      if (contributor) {
        contributor.costMinor += cost;
      }
      return acc + cost;
    }, 0);

    const totalHours = Array.from(contributors.values()).reduce(
      (acc, contributor) => acc + contributor.hours,
      0,
    );

    const contributorRows =
      contributors.size === 0
        ? []
        : await db
            .select({
              id: usersTable.id,
              name: usersTable.name,
              email: usersTable.email,
            })
            .from(usersTable)
            .where(inArray(usersTable.id, userIds));

    const contributorMap = new Map(contributorRows.map((row) => [row.id, row]));

    const contributorSummaries = Array.from(contributors.values())
      .map((item) => {
        const info = contributorMap.get(item.userId);
        return {
          userId: item.userId,
          userName: info?.name ?? null,
          userEmail: info?.email ?? null,
          totalHours: Number(item.hours.toFixed(2)),
          totalCostMinor: Math.round(item.costMinor),
        };
      })
      .sort((a, b) => (b.totalCostMinor ?? 0) - (a.totalCostMinor ?? 0));

    const budgetUtilisationPct = project.budgetAmountMinor
      ? Math.min(
          100,
          Number(
            (
              (totalCostMinor / Number(project.budgetAmountMinor)) *
              100
            ).toFixed(2),
          ),
        )
      : null;

    return {
      projectId,
      projectName: project.name,
      window: {
        from: fromDate ?? null,
        to: params.to ? new Date(params.to) : null,
      },
      totalHours: Number(totalHours.toFixed(2)),
      totalCostMinor: Math.round(totalCostMinor),
      budgetCurrency: project.budgetCurrency,
      budgetAmountMinor: project.budgetAmountMinor,
      budgetUtilisationPct,
      contributors: contributorSummaries,
    };
  }
}
