export interface OrderItem {
  producto: string;
  cantidad: number;
  precioUnit: number;
}

export interface Order {
  cliente: string;
  direccion: string;
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

export function formatOrderSummary(order: Order): string {
  const lines: string[] = [];

  lines.push("*✅ PEDIDO CONFIRMADO — Buenos Sabores*");
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");
  lines.push(`*👤 Cliente:* ${order.cliente}`);
  lines.push(`*📍 Entrega:* ${order.direccion}`);
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
  lines.push(`*💰 TOTAL: $${fmt(total)}*`);
  lines.push("━━━━━━━━━━━━━━━━━━━━━━━");

  if (order.notas) {
    lines.push(`📝 ${order.notas}`);
    lines.push("");
  }

  lines.push("Enseguida nos ponemos en contacto para coordinar la entrega. ¡Gracias por elegir Buenos Sabores! 🧡");

  return lines.join("\n");
}
