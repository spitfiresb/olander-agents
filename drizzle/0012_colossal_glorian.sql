CREATE TABLE "reference_document" (
	"id" text PRIMARY KEY NOT NULL,
	"filename" text NOT NULL,
	"mediaType" text NOT NULL,
	"sizeBytes" integer NOT NULL,
	"blobUrl" text NOT NULL,
	"blobPathname" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"chunkCount" integer DEFAULT 0 NOT NULL,
	"error" text,
	"uploadedBy" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "reference_document_created_idx" ON "reference_document" USING btree ("createdAt");