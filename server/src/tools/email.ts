import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { EmailService } from "../services/emailService.js";

/**
 * Agent tool: send an email via the configured SMTP server (Feature 2).
 * Mirrors the `/email` slash command and the agents.yaml `email` tool entry.
 */
export function createEmailTool(email: EmailService) {
  return defineTool({
    name: "email",
    label: "Send Email",
    description:
      "Send an email via the configured SMTP server. Returns success/failure and a status message. SMTP must be configured in Settings first.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient email address" }),
      subject: Type.String({ description: "Email subject line" }),
      body: Type.String({ description: "Plain-text email body" }),
    }),
    execute: async (_toolCallId, params) => {
      const result = await email.sendEmail(params.to, params.subject, params.body);
      const text = result.ok
        ? `Email sent to ${params.to} (messageId: ${result.messageId ?? "n/a"}).`
        : `Email failed: ${result.message}`;
      return {
        content: [{ type: "text", text }],
        details: { success: result.ok, message: result.message, messageId: result.messageId },
      };
    },
  });
}
