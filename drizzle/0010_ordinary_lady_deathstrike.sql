CREATE TABLE "chat_error" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"userId" text,
	"conversationId" text,
	"phase" text NOT NULL,
	"code" text,
	"httpStatus" integer,
	"errorName" text,
	"errorMessage" text,
	"errorStack" text,
	"provider" text,
	"model" text,
	"query" text,
	"toolCallCount" integer,
	"finishReason" text
);
--> statement-breakpoint
CREATE INDEX "chat_error_created_idx" ON "chat_error" USING btree ("createdAt");