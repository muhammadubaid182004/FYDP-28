import { pgTable, text, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const patientsTable = pgTable(
  "patients",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fullName: text("full_name").notNull(),
    cnic: text("cnic").notNull(),
    phone: text("phone").notNull(),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    cnicIdx: uniqueIndex("patients_cnic_uidx").on(table.cnic),
    creatorIdx: index("patients_created_by_user_idx").on(table.createdByUserId),
  }),
);

export type Patient = typeof patientsTable.$inferSelect;
export type NewPatient = typeof patientsTable.$inferInsert;
