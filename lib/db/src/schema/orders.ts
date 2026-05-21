import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const ordersTable = pgTable("orders", {
  id: text("id").primaryKey(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  customerPhone: text("customer_phone").notNull(),
  cliente: text("cliente").notNull(),
  direccion: text("direccion").notNull(),
  zonaEntrega: text("zona_entrega"),
  pago: text("pago").notNull(),
  items: jsonb("items").notNull(),
  notas: text("notas"),
  total: integer("total").notNull(),
});

export const insertOrderSchema = createInsertSchema(ordersTable).omit({
  receivedAt: true,
});
export type InsertOrder = z.infer<typeof insertOrderSchema>;
export type DbOrder = typeof ordersTable.$inferSelect;
