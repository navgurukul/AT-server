CREATE TABLE "departments" (
"id" serial PRIMARY KEY,
"org_id" integer NOT NULL,
"name" varchar(160) NOT NULL,
"code" varchar(50),
"description" text,
"created_at" timestamp with time zone DEFAULT now(),
"updated_at" timestamp with time zone DEFAULT now(),
CONSTRAINT "departments_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "orgs"("id") ON DELETE cascade
);

ALTER TABLE "users"
ADD COLUMN "department_id" integer;

ALTER TABLE "users"
ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE set null;
