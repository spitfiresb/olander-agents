ALTER TABLE "message" ADD COLUMN "supersededAt" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "msg_conv_superseded_idx" ON "message" USING btree ("conversationId","supersededAt");