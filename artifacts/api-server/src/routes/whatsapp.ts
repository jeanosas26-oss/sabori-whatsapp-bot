import { Router, type IRouter, type Request, type Response } from "express";
import { twilioClient, validateTwilioSignature } from "../lib/twilio";
import { getAIReply } from "../lib/claude";
import { getHistory, appendMessages } from "../lib/conversation";
import { parseReply, formatOrderSummary, formatStaffNotification } from "../lib/order";
import { saveOrder } from "../lib/orderStore";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function sendWhatsApp(from: string, to: string, body: string): Promise<void> {
  await twilioClient.messages.create({ from, to, body });
}

async function handleWebhook(req: Request, res: Response): Promise<void> {
  const params: Record<string, string> =
    req.method === "GET"
      ? (req.query as Record<string, string>)
      : (req.body as Record<string, string>);

  const signature = req.headers["x-twilio-signature"] as string | undefined;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const fullUrl = `${proto}://${req.get("host")}${req.originalUrl}`;

  if (signature) {
    const isValid = validateTwilioSignature(signature, fullUrl, params);
    if (!isValid) {
      logger.warn({ url: fullUrl, method: req.method }, "Invalid Twilio signature — request rejected");
      res.status(403).send("Forbidden");
      return;
    }
  } else {
    logger.warn({ method: req.method }, "No Twilio signature header — skipping validation (dev mode)");
  }

  const incomingMessage = params.Body;
  const from = params.From;
  const to = params.To;

  if (!incomingMessage || !from) {
    res.status(400).send("Bad Request");
    return;
  }

  req.log.info({ from, method: req.method, messageLength: incomingMessage.length }, "Received WhatsApp message");

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

    try {
      await sendWhatsApp(to, from, formatOrderSummary(order));
      req.log.info({ to: from }, "Order summary sent to customer");
    } catch (err) {
      req.log.error({ err }, "Failed to send order summary to customer");
    }

    await saveOrder(from, order);

    const STORE_NUMBER = "whatsapp:+542617617618";
    try {
      await sendWhatsApp(to, STORE_NUMBER, formatStaffNotification(order, from));
      req.log.info({ to: STORE_NUMBER }, "Order forwarded to store");
    } catch (err) {
      req.log.error({ err }, "Failed to forward order to store");
    }
  }

  res.status(200).send("OK");
}

router.get("/whatsapp/webhook", handleWebhook);
router.post("/whatsapp/webhook", handleWebhook);

export default router;
