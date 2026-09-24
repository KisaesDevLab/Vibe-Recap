CREATE TABLE "extraction_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"path" text NOT NULL,
	"value" bigint,
	"extracted_value" bigint,
	"reason" text NOT NULL,
	"software" text,
	"tax_year" integer,
	"profile" text,
	"evidence" jsonb,
	"created_by" uuid,
	"created_by_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	"removed_by_label" text,
	"values_purged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "extraction_overrides" ADD CONSTRAINT "extraction_overrides_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_overrides" ADD CONSTRAINT "extraction_overrides_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extraction_overrides_job_idx" ON "extraction_overrides" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "extraction_overrides_created_idx" ON "extraction_overrides" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_overrides_active_uq" ON "extraction_overrides" USING btree ("job_id","path") WHERE "extraction_overrides"."removed_at" is null;