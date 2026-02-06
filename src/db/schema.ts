import {
  pgTable,
  serial,
  integer,
  varchar,
  timestamp,
  pgEnum,
  char,
  numeric,
  jsonb,
  boolean,
  text,
  date,
  smallint,
  uniqueIndex,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";

export const userStatusEnum = pgEnum("user_status", [
  "active",
  "inactive",
  "suspended",
]);

export const roleKeyEnum = pgEnum("role_key", [
  "super_admin",
  "admin",
  "hr",
  "manager",
  "employee",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "draft",
  "active",
  "on_hold",
  "completed",
  "archived",
]);

export const timesheetStateEnum = pgEnum("timesheet_state", [
  "draft",
  "submitted",
  "approved",
  "rejected",
  "locked",
]);

export const leaveStateEnum = pgEnum("leave_state", [
  "pending",
  "approved",
  "rejected",
  "cancelled",
]);

export const compOffStatusEnum = pgEnum("comp_off_status", [
  "granted",
  "expired",
  "revoked",
]);

export const decisionEnum = pgEnum("decision", [
  "pending",
  "approved",
  "rejected",
]);

export const freezeStateEnum = pgEnum("freeze_state", ["open", "frozen"]);

export const jobStatusEnum = pgEnum("job_status", [
  "pending",
  "running",
  "done",
  "error",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "email",
  "slack",
  "discord",
]);

export const orgs = pgTable("orgs", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 200 }).notNull(),
  code: varchar("code", { length: 50 }).notNull().unique(),
  status: varchar("status", { length: 50 }).default("active"),
  timezone: varchar("timezone", { length: 100 }).default("Asia/Kolkata"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 160 }).notNull(),
  code: varchar("code", { length: 50 }),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const employeeDepartments = pgTable("employee_departments", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 160 }).notNull().unique(),
  code: varchar("code", { length: 50 }),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    email: varchar("email", { length: 320 }).notNull().unique(),
    name: varchar("name", { length: 160 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    status: userStatusEnum().notNull().default("active"),
    managerId: integer("manager_id"),
    employeeDepartmentId: integer("employee_department_id").references(
      () => employeeDepartments.id,
      { onDelete: "set null" },
    ),
    workLocationType: varchar("work_location_type", { length: 120 }),
    dateOfJoining: date("date_of_joining"),
    employmentType: varchar("employment_type", { length: 160 }),
    employmentStatus: varchar("employment_status", { length: 64 }),
    dateOfExit: date("date_of_exit"),
    slackId: varchar("slack_id", { length: 160 }),
    alumniStatus: varchar("alumni_status", { length: 120 }),
    gender: varchar("gender", { length: 32 }),
    discordId: varchar("discord_id", { length: 160 }),
    rolePrimary: roleKeyEnum().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    avatarUrl: varchar("avatar_url", { length: 512 }),
    googleUserId: varchar("google_user_id", { length: 255 }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => ({
    managerReference: foreignKey({
      columns: [table.managerId],
      foreignColumns: [table.id],
      name: "users_manager_id_fkey",
    }),
  })
);

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 64 }).notNull().unique(),
  name: varchar("name", { length: 120 }).notNull(),
  description: text("description"),
  createdAt: timestamp("createdAt", { withTimezone: true }),
});

export const userRoles = pgTable(
  "user_roles",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.roleId] }),
  })
);

export const permissions = pgTable("permissions", {
  id: serial("id").primaryKey(),
  key: varchar("key", { length: 128 }).notNull().unique(),
  description: varchar("description", { length: 240 }),
  createdAt: timestamp("createdAt", { withTimezone: true }),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id),
    permissionId: integer("permission_id")
      .notNull()
      .references(() => permissions.id),
    legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.roleId, table.permissionId] }),
  })
);

export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  departmentId: integer("department_id")
    .notNull()
    .references(() => departments.id),
  projectManagerId: integer("project_manager_id")
    .notNull()
    .references(() => users.id),
  name: varchar("name", { length: 200 }).notNull(),
  code: varchar("code", { length: 40 }).notNull().unique(),
  status: projectStatusEnum().notNull().default("active"),
  startDate: timestamp("start_date", { withTimezone: true }),
  endDate: timestamp("end_date", { withTimezone: true }),
  budgetCurrency: char("budget_currency", { length: 3 }),
  budgetAmount: numeric("budget_amount", { precision: 12, scale: 2 }),
  budgetAmountMinor: numeric("budget_amount_minor", {
    precision: 18,
    scale: 0,
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  description: text("description"),
  slackChannelId: varchar("slack_channel_id", { length: 200 }),
  discordChannelId: varchar("discord_channel_id", { length: 200 }),
});

export const projectMembers = pgTable(
  "project_members",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    role: varchar("role", { length: 80 }).notNull().default("contributor"),
    allocationPct: numeric("allocation_pct", { precision: 5, scale: 2 })
      .notNull()
      .default("100"),
    startDate: timestamp("start_date", { withTimezone: true }),
    endDate: timestamp("end_date", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.projectId] }),
  })
);

export const costRates = pgTable("cost_rates", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),
  hourlyCostMinor: integer("hourly_cost_minor_currency").notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  legacyNotes: text("notes"),
  legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
});

export const timesheets = pgTable(
  "timesheets",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    workDate: timestamp("work_date", { withTimezone: true }).notNull(),
    state: timesheetStateEnum().notNull().default("draft"),
    totalHours: numeric("total_hours", { precision: 5, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    legacyLockedByUserId: integer("locked_by_user_id"),
  },
  (table) => ({
    uniqUserDate: uniqueIndex("uniq_user_date").on(
      table.orgId,
      table.userId,
      table.workDate
    ),
  })
);

export const timesheetEntries = pgTable("timesheet_entries", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  timesheetId: integer("timesheet_id")
    .notNull()
    .references(() => timesheets.id),
  projectId: integer("project_id").references(() => projects.id),
  taskTitle: text("task_title"),
  taskDescription: text("task_description"),
  hoursDecimal: numeric("hours_decimal", { precision: 5, scale: 2 }).notNull(),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const leaveTypes = pgTable("leave_types", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  code: text("code").notNull(),
  name: text("name").notNull(),
  paid: boolean("paid").notNull().default(true),
  requiresApproval: boolean("requires_approval").notNull().default(true),
  description: text("description"),
  maxPerRequestHours: numeric("max_per_request_hours", {
    precision: 6,
    scale: 2,
  }),
  createdAt: timestamp("createdAt", { withTimezone: true }),
});

export const leavePolicies = pgTable("leave_policies", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  leaveTypeId: integer("leave_type_id")
    .notNull()
    .references(() => leaveTypes.id),
  accrualRule: jsonb("accrual_rule"),
  carryForwardRule: jsonb("carry_forward_rule"),
  maxBalance: numeric("max_balance", { precision: 6, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const leaveBalances = pgTable("leave_balances", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  leaveTypeId: integer("leave_type_id")
    .notNull()
    .references(() => leaveTypes.id),
  balanceHours: numeric("balance_hours", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
  pendingHours: numeric("pending_hours", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
  bookedHours: numeric("booked_hours", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
  asOfDate: date("as_of_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
  legacyUpdatedAt: timestamp("updatedAt", { withTimezone: true }),
});

export const leaveRequests = pgTable("leave_requests", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  leaveTypeId: integer("leave_type_id")
    .notNull()
    .references(() => leaveTypes.id),
  startDate: timestamp("start_date", { withTimezone: true }).notNull(),
  endDate: timestamp("end_date", { withTimezone: true }).notNull(),
  durationType: varchar("duration_type", { length: 20 })
    .notNull()
    .default("custom"),
  halfDaySegment: varchar("half_day_segment", { length: 20 }),
  hours: numeric("hours", { precision: 6, scale: 2 }).notNull(),
  reason: text("reason"),
  state: leaveStateEnum().notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow(),
  decidedByUserId: integer("decided_by_user_id").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const compOffCredits = pgTable("comp_off_credits", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  managerId: integer("manager_id")
    .notNull()
    .references(() => users.id),
  createdBy: integer("created_by")
    .notNull()
    .references(() => users.id),
  timesheetId: integer("timesheet_id").references(() => timesheets.id),
  workDate: date("work_date").notNull(),
  durationType: varchar("duration_type", { length: 20 }).notNull(),
  creditedHours: numeric("credited_hours", { precision: 5, scale: 2 }).notNull(),
  timesheetHours: numeric("timesheet_hours", { precision: 5, scale: 2 }),
  status: compOffStatusEnum().notNull().default("granted"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const approvals = pgTable("approvals", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  subjectType: varchar("subject_type", { length: 80 }).notNull(),
  subjectId: integer("subject_id").notNull(),
  approverId: integer("approver_id")
    .notNull()
    .references(() => users.id),
  decision: decisionEnum().notNull().default("pending"),
  comment: text("comment"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  legacySubjectType: varchar("subjectType", { length: 80 }),
  legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
});

export const payrollWindows = pgTable(
  "payroll_windows",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    year: smallint("year").notNull(),
    month: smallint("month").notNull(),
    freezeState: freezeStateEnum("freeze_state").notNull().default("open"),
    frozenAt: timestamp("frozen_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    legacyUpdatedAt: timestamp("updatedAt", { withTimezone: true }),
  },
  (table) => ({
    uniqWindow: uniqueIndex("uniq_payroll_window").on(
      table.orgId,
      table.year,
      table.month
    ),
  })
);

export const jobs = pgTable("jobs", {
  id: serial("id").primaryKey(),
  type: varchar("type", { length: 80 }).notNull(),
  payload: jsonb("payload").notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  attempts: smallint("attempts").notNull().default(0),
  status: jobStatusEnum().notNull().default("pending"),
  lockedBy: varchar("locked_by", { length: 64 }),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  legacyOrgId: integer("org_id"),
  legacyJobType: varchar("job_type", { length: 80 }),
  legacyPriority: integer("priority"),
  legacyRunAfter: timestamp("run_after", { withTimezone: true }),
  legacyLastRunAt: timestamp("last_run_at", { withTimezone: true }),
  legacyMaxAttempts: smallint("max_attempts"),
  legacyErrorText: text("error_text"),
  legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
  legacyUpdatedAt: timestamp("updatedAt", { withTimezone: true }),
});

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  channel: notificationChannelEnum().notNull(),
  toRef: jsonb("to_ref").notNull(),
  template: varchar("template", { length: 150 }).notNull(),
  payload: jsonb("payload").default("{}"),
  state: varchar("state", { length: 50 }).default("pending"),
  errorText: text("error_text"),
  attempts: integer("attempts").default(0),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const eventOutbox = pgTable("event_outbox", {
  id: serial("id").primaryKey(),
  eventType: varchar("event_type", { length: 80 }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  legacyOrgId: integer("org_id"),
  legacyEventType: varchar("eventType", { length: 80 }),
  legacyMetadata: jsonb("metadata"),
  legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
  legacyErrorText: text("error_text"),
  legacyAttempts: integer("attempts"),
});

export const requestKeys = pgTable(
  "request_keys",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    idempotencyKey: varchar("idempotency_key", { length: 255 })
      .notNull()
      .unique(),
    requestHash: varchar("request_hash", { length: 255 }).notNull(),
    responsePayload: jsonb("response_payload"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    idxOrgKey: uniqueIndex("uniq_request_key_org").on(
      table.orgId,
      table.idempotencyKey
    ),
  })
);

export const auditLogs = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  orgId: integer("org_id")
    .notNull()
    .references(() => orgs.id),
  actorUserId: integer("actor_user_id").references(() => users.id),
  actorRole: varchar("actor_role", { length: 32 }),
  action: varchar("action", { length: 120 }).notNull(),
  subjectType: varchar("subject_type", { length: 80 }).notNull(),
  subjectId: integer("subject_id"),
  prev: jsonb("prev"),
  next: jsonb("next"),
  meta: jsonb("meta"),
  at: timestamp("at", { withTimezone: true }).defaultNow().notNull(),
  legacySubjectType: varchar("subjectType", { length: 80 }),
  legacyMetadata: jsonb("metadata"),
  legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
});

export const authBlacklistedTokens = pgTable(
  "auth_blacklisted_tokens",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    token: text("token").notNull(),
    tokenType: varchar("token_type", { length: 20 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    legacyCreatedAt: timestamp("createdAt", { withTimezone: true }),
  },
  (table) => ({
    tokenIdx: uniqueIndex("uq_auth_blacklisted_tokens_token").on(table.token),
  })
);

export const backfillCounters = pgTable(
  "backfill_counters",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
  year: smallint("year").notNull(),
  month: smallint("month").notNull(),
  used: smallint("used").notNull().default(0),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  limit: smallint("limit").notNull().default(3),
},
  (table) => ({
    uniqUserMonth: uniqueIndex("uniq_backfill_user_month").on(
      table.orgId,
      table.userId,
      table.year,
      table.month
    ),
  })
);

export const backfillDates = pgTable(
  "backfill_dates",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    year: smallint("year").notNull(),
    month: smallint("month").notNull(),
    workDate: date("work_date").notNull(),
  },
  (table) => ({
    uniq: uniqueIndex("uniq_backfill_date").on(
      table.orgId,
      table.userId,
      table.year,
      table.month,
      table.workDate
    ),
  })
);

export const mvProjectCostsMonthly = pgTable(
  "mv_project_costs_monthly",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    hoursSum: numeric("hours_sum", { precision: 8, scale: 2 }).default("0"),
    costMinorSum: integer("cost_minor_sum").default(0),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.year, table.month] }),
  })
);

export const mvUserProductivityDaily = pgTable(
  "mv_user_productivity_daily",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    workDate: date("work_date").notNull(),
    totalHours: numeric("total_hours", { precision: 5, scale: 2 }).default("0"),
    submittedFlag: boolean("submitted_flag").default(false),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.workDate] }),
  })
);

export const mvLeaveTrendsMonthly = pgTable(
  "mv_leave_trends_monthly",
  {
    leaveTypeId: integer("leave_type_id")
      .notNull()
      .references(() => leaveTypes.id),
    year: integer("year").notNull(),
    month: integer("month").notNull(),
    hoursSum: numeric("hours_sum", { precision: 8, scale: 2 }).default("0"),
    refreshedAt: timestamp("refreshed_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.leaveTypeId, table.year, table.month] }),
  })
);

export const schema = {
  orgs,
  departments,
  users,
  roles,
  userRoles,
  permissions,
  rolePermissions,
  projects,
  projectMembers,
  costRates,
  timesheets,
  timesheetEntries,
  leaveTypes,
  leavePolicies,
  leaveBalances,
  leaveRequests,
  approvals,
  payrollWindows,
  jobs,
  notifications,
  eventOutbox,
  requestKeys,
  auditLogs,
  authBlacklistedTokens,
  backfillCounters,
  backfillDates,
  mvProjectCostsMonthly,
  mvUserProductivityDaily,
  mvLeaveTrendsMonthly,
};

// Legacy aliases to maintain compatibility with existing imports
export const orgsTable = orgs;
export const departmentsTable = departments;
export const employeeDepartmentsTable = employeeDepartments;
export const usersTable = users;
export const rolesTable = roles;
export const userRolesTable = userRoles;
export const permissionsTable = permissions;
export const rolePermissionsTable = rolePermissions;
export const projectsTable = projects;
export const projectMembersTable = projectMembers;
export const costRatesTable = costRates;
export const timesheetsTable = timesheets;
export const timesheetEntriesTable = timesheetEntries;
export const leaveTypesTable = leaveTypes;
export const leavePoliciesTable = leavePolicies;
export const leaveBalancesTable = leaveBalances;
export const leaveRequestsTable = leaveRequests;
export const compOffCreditsTable = compOffCredits;
export const approvalsTable = approvals;
export const payrollWindowsTable = payrollWindows;
export const jobsTable = jobs;
export const notificationsTable = notifications;
export const eventOutboxTable = eventOutbox;
export const requestKeysTable = requestKeys;
export const auditLogsTable = auditLogs;
export const authBlacklistedTokensTable = authBlacklistedTokens;
export const backfillCountersTable = backfillCounters;
export const backfillDatesTable = backfillDates;
export const mvProjectCostsMonthlyTable = mvProjectCostsMonthly;
export const mvUserProductivityDailyTable = mvUserProductivityDaily;
export const mvLeaveTrendsMonthlyTable = mvLeaveTrendsMonthly;

export const orgHolidays = pgTable(
  "org_holidays",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => orgs.id),
    date: date("date").notNull(),
    name: varchar("name", { length: 160 }).notNull(),
    isWorkingDay: boolean("is_working_day").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    uniqOrgDate: uniqueIndex("uniq_org_holiday").on(table.orgId, table.date),
  })
);

export const orgHolidaysTable = orgHolidays;
