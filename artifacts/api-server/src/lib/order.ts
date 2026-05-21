export interface OrderItem {
  producto: string;
  cantidad: number;
  precioUnit: number;
}

export interface Order {
  cliente: string;
  direccion: string;
  zonaEntrega?: string;
  pago: string;
  items: OrderItem[];
  notas?: string;
}

const ORDER_MARKER_RE = /\[\[ORDER:([\s\S]*?)\]\]/;

export interface ParsedReply {
  text: string;
  order: Order | null;
}

export function parseReply(raw: string): ParsedReply {
  const match = raw.match(ORDER_MARKER_RE);
  if (!match) {
    return { text: raw, order: null };
  }

  const text = raw.replace(ORDER_MARKER_RE, "").trim();

  try {
    const order = JSON.parse(match[1]) as Order;
    if (!order.cliente || !order.direccion || !order.pago || !Array.isArray(order.items)) {
      return { text, order: null };
    }
    return { text, order };
  } catch {
    return { text, order: null };
  }
}

function fmt(n: number): string {
  return n.toLocaleString("es-AR");
}

export function formatStaffNotification(order: Order, customerPhone: string): string {
  const lines: string[] = [];
  const now = new Date().toLocaleString("es-AR", {
    timeZone: "America/Argentina/Mendoza",
    dateStyle: "short",
    timeStyle: "short",
  });

  lines.push("🔔 *NUEVO PEDIDO — Buenos Sabores*");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`🕐 ${now}`);
  lines.push(`👤 *Cliente:* ${order.cliente}`);
  lines.push(`📱 *WhatsApp:* ${customerPhone.replace("whatsapp:", "")}`);
  lines.push(`📍 *Entrega:* ${order.direccion}`);
  if (order.zonaEntrega) lines.push(`🗺 *Zona:* ${order.zonaEntrega}`);
  lines.push(`💳 *Pago:* ${order.pago}`);
  lines.push(`🛵 *Envío:* A confirmar por el local`);
  lines.push("");
  lines.push("*🛒 Productos:*");

  let total = 0;
  for (const item of order.items) {
    const subtotal = item.cantidad * item.precioUnit;
    total += subtotal;
    const cant = item.cantidad > 1 ? `${item.cantidad}x ` : "";
    lines.push(`  - ${cant}${item.producto}  $${fmt(subtotal)}`);
  }

  lines.push("");
  lines.push(`*💰 Subtotal productos: $${fmt(total)}*`);
  lines.push(`*🛵 Envío: A confirmar*`);

  if (order.notas) {
    lines.push(`📝 *Notas:* ${order.notas}`);
  }

  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");

  return lines.join("\n");
}

export function formatOrderSummary(order: Order): string {
  const lines: string[] = [];

  lines.push("*✅ PEDIDO CONFIRMADO — Buenos Sabores*");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`*👤 Cliente:* ${order.cliente}`);
  lines.push(`*📍 Entrega:* ${order.direccion}`);
  if (order.zonaEntrega) lines.push(`*🗺 Zona:* ${order.zonaEntrega}`);
  lines.push(`*💳 Pago:* ${order.pago}`);
  lines.push("");
  lines.push("*🛒 Tu pedido:*");

  let total = 0;
  for (const item of order.items) {
    const subtotal = item.cantidad * item.precioUnit;
    total += subtotal;
    const cant = item.cantidad > 1 ? `${item.cantidad}x ` : "";
    lines.push(`  - ${cant}${item.producto}  $${fmt(subtotal)}`);
  }

  lines.push("");
  lines.push(`*💰 Subtotal: $${fmt(total)}*`);
  lines.push(`*🛵 Envío: A confirmar por el local*`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");

  if (order.notas) {
    lines.push(`📝 ${order.notas}`);
    lines.push("");
  }

  lines.push("Enseguida te confirmamos el costo de envío y coordinamos la entrega. ¡Gracias por elegir Buenos Sabores! 🧡");

  return lines.join("\n");
}
