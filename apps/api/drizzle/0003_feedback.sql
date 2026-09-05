CREATE TABLE "job_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_label" text NOT NULL,
	"verdict" text NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"hold_until" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"dismissed_by" uuid,
	"dismissed_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_feedback" ADD CONSTRAINT "job_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_feedback_job_idx" ON "job_feedback" USING btree ("job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_feedback_job_user_uq" ON "job_feedback" USING btree ("job_id","user_id");--> statement-breakpoint
CREATE INDEX "job_feedback_hold_idx" ON "job_feedback" USING btree ("hold_until");