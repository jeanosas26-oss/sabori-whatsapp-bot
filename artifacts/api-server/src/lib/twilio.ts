import twilio from "twilio";
import { logger } from "./logger";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

if (!accountSid || !authToken) {
  throw new Error(
    "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN environment variables are required.",
  );
}

const resolvedAuthToken = authToken;

export const twilioClient = twilio(accountSid, resolvedAuthToken);

export function validateTwilioSignature(
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  try {
    return twilio.validateRequest(resolvedAuthToken, signature, url, params);
  } catch (err) {
    logger.warn({ err }, "Twilio signature validation error");
    return false;
  }
}
