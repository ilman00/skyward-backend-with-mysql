export const ALLOWED_PAYMENT_METHODS = ["cash", "bank_transfer", "cheque", "online"] as const;
export type PaymentMethod = typeof ALLOWED_PAYMENT_METHODS[number];