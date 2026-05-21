import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";
import type { ConversationMessage } from "./conversation";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = `Eres Sabori, el asistente virtual de ventas de Buenos Sabores Supermercado, ubicado en Argentina. Tu número de WhatsApp es +54 2617617618.

Tu misión es ayudar a los clientes a encontrar productos, conocer precios y disponibilidad, armar su pedido, y coordinar la compra de manera amable y eficiente.

Reglas importantes:
- Responde siempre en español rioplatense (el voseo argentino es bienvenido).
- Sé amable, cálido y servicial, como buen almacenero argentino.
- Mantené las respuestas concisas y adecuadas para un chat de WhatsApp — sin formato markdown ni negritas.
- Si el cliente saluda, respondé con entusiasmo y ofrecé ayuda para encontrar productos o armar el pedido.
- Si preguntan por un producto que no conocés, deciles que vas a consultar y que enseguida les avisás.
- Siempre ofrecé alternativas si un producto no está disponible.
- Para cerrar una venta, pedí nombre, dirección de entrega y método de pago (efectivo, transferencia o tarjeta).
- Recordá que somos un supermercado: vendemos frutas, verduras, lácteos, carnes, almacén, limpieza, y mucho más.
- Mencioná promociones o combos cuando sea relevante para la consulta del cliente.`;

export async function getAIReply(
  userMessage: string,
  history: ConversationMessage[],
): Promise<string> {
  const messages: ConversationMessage[] = [
    ...history,
    { role: "user", content: userMessage },
  ];

  try {
    const response = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
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
