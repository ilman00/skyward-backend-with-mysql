// src/services/transactionNotificationService.ts
import nodemailer from "nodemailer";
import { getActiveRecipientEmails } from "./notificationRecipientService";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const TYPE_LABELS: Record<string, string> = {
  income_sale: "SMD Sale Payment Received",
  rent_payout: "Rent Payout Sent",
  commission_payout: "Marketer Commission Paid",
};

// human-friendly labels for context keys, so exec's don't see raw db field names
const CONTEXT_LABELS: Record<string, string> = {
  smd_closing_id: "Deal Reference",
  smd_id: "SMD",
  smd_code: "SMD Code",
  customer_id: "Customer ID",
  customer_name: "Customer",
  marketer_id: "Marketer ID",
  marketer_name: "Marketer",
  payout_month: "Payout Month",
  payment_method: "Payment Method",
  reference_no: "Reference No.",
};

interface TransactionNotificationPayload {
  type: "income_sale" | "rent_payout" | "commission_payout";
  direction: "in" | "out";
  amount: number;
  txn_date: Date;
  context?: Record<string, string | number | undefined>;
}

const formatContextValue = (key: string, value: string | number) => {
  if (key === "payment_method" && typeof value === "string") {
    return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return value;
};

const buildEmailHtml = (payload: TransactionNotificationPayload) => {
  const isIncoming = payload.direction === "in";
  const accentColor = isIncoming ? "#16a34a" : "#dc2626"; // green for in, red for out
  const badgeText = isIncoming ? "MONEY IN" : "MONEY OUT";
  const formattedAmount = `Rs. ${payload.amount.toLocaleString()}`;
  const formattedDate = new Date(payload.txn_date).toLocaleString("en-PK", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  const contextRows = Object.entries(payload.context ?? {})
    .filter((entry): entry is [string, string | number] => {
      const v = entry[1];
      return v !== undefined && v !== null && v !== "";
   })
    .map(
      ([key, value]) => `
        <tr>
          <td style="padding:8px 0;color:#6b7280;font-size:13px;width:40%;">${CONTEXT_LABELS[key] ?? key}</td>
          <td style="padding:8px 0;color:#111827;font-size:13px;font-weight:600;">${formatContextValue(key, value)}</td>
        </tr>`
    )
    .join("");

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">
    <div style="background:#111827;padding:20px 24px;">
      <span style="color:#ffffff;font-size:15px;font-weight:700;">Skyward Vision</span>
    </div>

    <div style="padding:24px;">
      <span style="display:inline-block;background:${accentColor}1A;color:${accentColor};font-size:12px;font-weight:700;letter-spacing:0.5px;padding:4px 10px;border-radius:999px;">
        ${badgeText}
      </span>

      <h1 style="margin:16px 0 4px;font-size:28px;color:${accentColor};">${formattedAmount}</h1>
      <p style="margin:0 0 20px;color:#374151;font-size:14px;">${TYPE_LABELS[payload.type]}</p>

      <table style="width:100%;border-collapse:collapse;border-top:1px solid #f3f4f6;">
        <tr>
          <td style="padding:8px 0;color:#6b7280;font-size:13px;width:40%;">Date</td>
          <td style="padding:8px 0;color:#111827;font-size:13px;font-weight:600;">${formattedDate}</td>
        </tr>
        ${contextRows}
      </table>
    </div>

    <div style="background:#f9fafb;padding:14px 24px;border-top:1px solid #e5e7eb;">
      <p style="margin:0;color:#9ca3af;font-size:11px;">This is an automated notification from Skyward Vision. Please do not reply to this email.</p>
    </div>
  </div>`;
};

const buildEmailText = (payload: TransactionNotificationPayload) => {
  const contextLines = Object.entries(payload.context ?? {})
    .filter((entry): entry is [string, string | number] => {
      const v = entry[1];
      return v !== undefined && v !== null && v !== "";
    })
    .map(([key, value]) => `${CONTEXT_LABELS[key] ?? key}: ${formatContextValue(key, value)}`)
    .join("\n");

  return [
    `${payload.direction === "in" ? "MONEY IN" : "MONEY OUT"}: ${TYPE_LABELS[payload.type]}`,
    ``,
    `Amount: Rs. ${payload.amount.toLocaleString()}`,
    `Date: ${new Date(payload.txn_date).toLocaleString()}`,
    contextLines,
  ].join("\n");
};

export const notifyTransaction = async (payload: TransactionNotificationPayload) => {
  const recipients = await getActiveRecipientEmails();
  if (recipients.length === 0) return;

  const subject = `[Skyward Vision] ${payload.direction === "in" ? "▲" : "▼"} ${TYPE_LABELS[payload.type]} — Rs. ${payload.amount.toLocaleString()}`;

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    bcc: recipients,
    subject,
    text: buildEmailText(payload),
    html: buildEmailHtml(payload),
  });
};