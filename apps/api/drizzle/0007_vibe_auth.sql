CREATE TABLE "auth_identities" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"email" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_identities_issuer_subject_uq" UNIQUE("issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "auth_revocations" (
	"subject_key" text PRIMARY KEY NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_sid" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "oidc_id_token_wrapped" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sso_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_revocations_until_idx" ON "auth_revocations" USING btree ("revoked_until");--> statement-breakpoint
CREATE INDEX "sessions_oidc_idx" ON "sessions" USING btree ("oidc_issuer","oidc_subject");