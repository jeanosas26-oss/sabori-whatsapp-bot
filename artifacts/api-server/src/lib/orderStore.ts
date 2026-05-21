import type { Order } from "./order";

export interface StoredOrder {
  id: string;
  receivedAt: string;
  customerPhone: string;
  order: Order;
  total: number;
}

const MAX_ORDERS = 200;
const store: StoredOrder[] = [];

export function saveOrder(customerPhone: string, order: Order): StoredOrder {
  const total = order.items.reduce((sum, i) => sum + i.cantidad * i.precioUnit, 0);
  const record: StoredOrder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    receivedAt: new Date().toISOString(),
    customerPhone: customerPhone.replace("whatsapp:", ""),
    order,
    total,
  };
  store.unshift(record);
  if (store.length > MAX_ORDERS) store.splice(MAX_ORDERS);
  return record;
}

export function getOrders(): StoredOrder[] {
  return store;
}
