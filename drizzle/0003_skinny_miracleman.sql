CREATE TABLE "org_holidays" (
	"id" serial PRIMARY KEY NOT NULL,
	"org_id" integer NOT NULL,
	"date" date NOT NULL,
	"name" varchar(160) NOT NULL,
	"is_working_day" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "org_holidays" ADD CONSTRAINT "org_holidays_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_org_holiday" ON "org_holidays" USING btree ("org_id","date");