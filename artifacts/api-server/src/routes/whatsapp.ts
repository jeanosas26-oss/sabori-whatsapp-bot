import { Router, type IRouter, type Request, type Response } from "express";
import { twilioClient, validateTwilioSignature } from "../lib/twilio";
import { getAIReply } from "../lib/claude";
import { getHistory, appendMessages } from "../lib/conversation";
import { parseReply, formatOrderSummary, formatStaffNotification } from "../lib/order";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function sendWhatsApp(from: string, to: string, body: string): Promise<void> {
  await twilioClient.messages.create({ from, to, body });
}

router.post("/whatsapp/webhook", async (req: Request, res: Response) => {
  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;

  if (signature) {
    const isValid = validateTwilioSignature(
      signature,
      fullUrl,
      req.body as Record<string, string>,
    );
    if (!isValid) {
      logger.warn({ url: fullUrl }, "Invalid Twilio signature — request rejected");
      res.status(403).send("Forbidden");
      return;
    }
  } else {
    logger.warn("No Twilio signature header — skipping validation (dev mode)");
  }

  const incomingMessage: string = req.body.Body as string;
  const from: string = req.body.From as string;
  const to: string = req.body.To as string;

  if (!incomingMessage || !from) {
    res.status(400).send("Bad Request");
    return;
  }

  req.log.info({ from, messageLength: incomingMessage.length }, "Received WhatsApp message");

  const history = getHistory(from);
  const rawReply = await getAIReply(incomingMessage, history);

  const { text: replyText, order } = parseReply(rawReply);

  appendMessages(from, [
    { role: "user", content: incomingMessage },
    { role: "assistant", content: replyText },
  ]);

  try {
    await sendWhatsApp(to, from, replyText);
    req.log.info({ to: from, historyLength: history.length + 2 }, "Sent WhatsApp reply");
  } catch (err) {
    req.log.error({ err }, "Failed to send WhatsApp reply via Twilio");
    res.status(500).send("Failed to send reply");
    return;
  }

  if (order) {
    req.log.info({ cliente: order.cliente, items: order.items.length }, "Order completed — sending summary");

    const summary = formatOrderSummary(order);

    try {
      await sendWhatsApp(to, from, summary);
      req.log.info({ to: from }, "Order summary sent to customer");
    } catch (err) {
      req.log.error({ err }, "Failed to send order summary to customer");
    }

    const STORE_NUMBER = "whatsapp:+542617617618";
    try {
      const staffNotification = formatStaffNotification(order, from);
      await sendWhatsApp(to, STORE_NUMBER, staffNotification);
      req.log.info({ to: STORE_NUMBER }, "Order forwarded to store");
    } catch (err) {
      req.log.error({ err }, "Failed to forward order to store");
    }
  }

  res.status(200).send("OK");
});

router.get("/whatsapp/webhook", (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    message: "Buenos Sabores WhatsApp bot is live. Configure Twilio to POST to this URL.",
    webhookUrl: `${req.protocol}://${req.get("host")}/api/whatsapp/webhook`,
  });
});

export default router;
