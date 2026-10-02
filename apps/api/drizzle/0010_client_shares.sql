CREATE TABLE "job_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"channel" text NOT NULL,
	"contact_wrapped" text,
	"contact_masked" text NOT NULL,
	"secret_hash" text,
	"secret_required" boolean DEFAULT false NOT NULL,
	"max_sessions" integer NOT NULL,
	"sessions_used" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"codes_sent" integer DEFAULT 0 NOT NULL,
	"cooldown_until" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_label" text,
	"wiped_at" timestamp with time zone,
	"first_viewed_at" timestamp with time zone,
	"created_by" uuid,
	"created_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_shares_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "share_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"share_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"actor_label" text,
	"ip" text,
	"user_agent" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_shares" ADD CONSTRAINT "job_shares_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_shares" ADD CONSTRAINT "job_shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_events" ADD CONSTRAINT "share_events_share_id_job_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."job_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_events" ADD CONSTRAINT "share_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_shares_job_idx" ON "job_shares" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_shares_expires_idx" ON "job_shares" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "share_events_share_idx" ON "share_events" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "share_events_job_idx" ON "share_events" USING btree ("job_id");