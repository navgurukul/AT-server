ALTER TABLE public.comp_off_credits
ADD COLUMN "leave_request_id" integer;

ALTER TABLE public.comp_off_credits
ADD CONSTRAINT "comp_off_credits_leave_request_id_leave_requests_id_fk"
FOREIGN KEY ("leave_request_id") REFERENCES public.leave_requests("id")
ON DELETE SET NULL;
