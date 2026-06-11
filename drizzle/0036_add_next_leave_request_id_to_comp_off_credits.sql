ALTER TABLE "comp_off_credits" 
ADD COLUMN "next_leave_request_id" integer;

ALTER TABLE "comp_off_credits" 
ADD CONSTRAINT "comp_off_credits_next_leave_request_id_leave_requests_id_fk" 
FOREIGN KEY ("next_leave_request_id") REFERENCES "public"."leave_requests"("id") 
ON DELETE set null;
