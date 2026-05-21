import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { ConversationMessage } from "./conversation";
import { fetchCatalog, formatCatalogForPrompt } from "./catalog";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const BASE_PROMPT = `Eres Sabori, el asistente virtual de ventas de Buenos Sabores Supermercado, ubicado en Argentina.

Datos del local:
- Dirección: Severo del Castillo y Durand
- WhatsApp: 2617617618
- Horario: Lun–Sáb 8:00–22:00 · Dom 9:00–20:00
- Delivery: Radio 5km · Consultá mínimo
- Instagram: @buenos.sabores.supermarket

Tu misión es ayudar a los clientes a encontrar productos, conocer precios y disponibilidad, armar su pedido, y coordinar la compra de manera amable y eficiente.

Reglas importantes:
- Respondé siempre en español rioplatense (el voseo argentino es bienvenido).
- Sé amable, cálido y servicial, como buen almacenero argentino.
- Mantené las respuestas concisas y adecuadas para un chat de WhatsApp — sin formato markdown ni negritas.
- Si el cliente saluda, respondé con entusiasmo y ofrecé ayuda para encontrar productos o armar el pedido.
- Mencioná las promos vigentes cuando sean relevantes para lo que pide el cliente.
- Si preguntan por un producto que no está en el catálogo, deciles que vas a consultar y que enseguida les avisás.
- Siempre ofrecé alternativas si un producto no está disponible o tiene stock bajo.
- Para cerrar una venta, pedí nombre, dirección de entrega y método de pago (efectivo, transferencia o tarjeta).
- Aceptamos: efectivo, débito, crédito y transferencias.`;

async function buildSystemPrompt(): Promise<string> {
  const catalog = await fetchCatalog();
  const catalogText = formatCatalogForPrompt(catalog);

  if (!catalogText) {
    return BASE_PROMPT;
  }

  return `${BASE_PROMPT}\n\n--- CATÁLOGO ACTUAL DEL LOCAL ---\n${catalogText}\n--- FIN DEL CATÁLOGO ---`;
}

export async function getAIReply(
  userMessage: string,
  history: ConversationMessage[],
): Promise<string> {
  const systemPrompt = await buildSystemPrompt();

  const messages: ConversationMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const block = response.content[0];
    if (block.type === "text") {
      return block.text;
    }
    return "Lo siento, no pude generar una respuesta. Intentá de nuevo.";
  } catch (err) {
    logger.error({ err }, "Anthropic API error");
    return "Lo siento, ocurrió un error. Por favor intentá de nuevo en unos segundos.";
  }
}
