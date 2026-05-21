import { db, ordersTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { Order, OrderItem } from "./order";
import { logger } from "./logger";

export interface StoredOrder {
  id: string;
  receivedAt: string;
  customerPhone: string;
  order: Order;
  total: number;
}

function toStoredOrder(row: typeof ordersTable.$inferSelect): StoredOrder {
  return {
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    customerPhone: row.customerPhone,
    total: row.total,
    order: {
      cliente: row.cliente,
      direccion: row.direccion,
      zonaEntrega: row.zonaEntrega ?? undefined,
      pago: row.pago,
      items: row.items as OrderItem[],
      notas: row.notas ?? undefined,
    },
  };
}

export async function saveOrder(
  customerPhone: string,
  order: Order,
): Promise<StoredOrder> {
  const total = order.items.reduce(
    (sum, i) => sum + i.cantidad * i.precioUnit,
    0,
  );
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const phone = customerPhone.replace("whatsapp:", "");

  try {
    await db.insert(ordersTable).values({
      id,
      customerPhone: phone,
      cliente: order.cliente,
      direccion: order.direccion,
      zonaEntrega: order.zonaEntrega ?? null,
      pago: order.pago,
      items: order.items,
      notas: order.notas ?? null,
      total,
    });
  } catch (err) {
    logger.error({ err }, "Failed to persist order to DB");
  }

  return {
    id,
    receivedAt: new Date().toISOString(),
    customerPhone: phone,
    order,
    total,
  };
}

export async function getOrders(): Promise<StoredOrder[]> {
  try {
    const rows = await db
      .select()
      .from(ordersTable)
      .orderBy(desc(ordersTable.receivedAt))
      .limit(200);
    return rows.map(toStoredOrder);
  } catch (err) {
    logger.error({ err }, "Failed to fetch orders from DB");
    return [];
  }
}
