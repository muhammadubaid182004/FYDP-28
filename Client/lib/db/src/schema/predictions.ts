import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { patientsTable } from "./patients";
import { usersTable } from "./users";

export const screeningOutcomeEnum = pgEnum("screening_outcome", ["NRDR", "RDR"]);
export const reviewStatusEnum = pgEnum("review_status", ["pending", "accepted", "rejected"]);

export const predictionsTable = pgTable(
  "predictions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patientsTable.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    imageStorageUri: text("image_storage_uri"),
    imageFilename: text("image_filename"),
    mimeType: text("mime_type"),
    severityLabel: text("severity_label").notNull(),
    screeningOutcome: screeningOutcomeEnum("screening_outcome"),
    confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
    recommendation: text("recommendation"),
    modelVersion: text("model_version"),
    jetsonInferenceTimeMs: integer("jetson_inference_time_ms"),
    requiresReview: boolean("requires_review").notNull().default(true),
    reviewStatus: reviewStatusEnum("review_status_val").notNull().default("pending"),
    clinicianComment: text("clinician_comment"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    patientIdx: index("predictions_patient_idx").on(table.patientId),
    reviewStatusIdx: index("predictions_review_status_idx").on(table.reviewStatus),
    createdAtIdx: index("predictions_created_at_idx").on(table.createdAt),
    confidenceRange: check("predictions_confidence_range_chk", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    reviewedState: check(
      "predictions_reviewed_state_chk",
      sql`(${table.reviewStatus} = 'pending' AND ${table.reviewedAt} IS NULL AND ${table.reviewedByUserId} IS NULL)
        OR (${table.reviewStatus} IN ('accepted', 'rejected') AND ${table.reviewedAt} IS NOT NULL AND ${table.reviewedByUserId} IS NOT NULL)`,
    ),
  }),
);

export type Prediction = typeof predictionsTable.$inferSelect;
export type NewPrediction = typeof predictionsTable.$inferInsert;
