CREATE TABLE "bereavement_leave_request" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "leave_request_id" integer NOT NULL UNIQUE,
  "relationship" varchar(64) NOT NULL,
  "relationship_details" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);

ALTER TABLE "bereavement_leave_request"
ADD CONSTRAINT "bereavement_leave_request_leave_request_id_leave_requests_id_fk"
FOREIGN KEY ("leave_request_id") REFERENCES "public"."leave_requests"("id") ON DELETE cascade ON UPDATE no action;