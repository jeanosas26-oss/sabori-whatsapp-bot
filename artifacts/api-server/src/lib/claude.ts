import Anthropic from "@anthropic-ai/sdk";
import { logger } from "./logger";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function getAIReply(userMessage: string): Promise<string> {
  try {
    const message = await client.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 1024,
      system:
        "You are a helpful WhatsApp assistant. Keep responses concise and friendly — suitable for a chat message. Avoid markdown formatting like bold or headers since WhatsApp renders plain text.",
      messages: [{ role: "user", content: userMessage }],
    });

    const block = message.content[0];
    if (block.type === "text") {
      return block.text;
    }
    return "Sorry, I could not generate a response.";
  } catch (err) {
    logger.error({ err }, "Anthropic API error");
    return "Sorry, something went wrong. Please try again.";
  }
}
