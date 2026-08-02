// src/controllers/notificationRecipientsController.ts
import { Request, Response } from "express";
import { pool } from "../config/db";
import { RowDataPacket, ResultSetHeader } from "mysql2";
import { randomUUID } from "crypto";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const getNotificationRecipients = async (req: Request, res: Response) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT recipient_id, name, email, role_label, is_active, created_at
       FROM notification_recipients
       ORDER BY created_at DESC`
    );
    res.status(200).json({ data: rows });
  } catch (error: any) {
    console.error("[getNotificationRecipients] Error:", error);
    res.status(500).json({ message: "Failed to fetch recipients" });
  }
};

export const createNotificationRecipient = async (req: Request, res: Response) => {
  try {
    const { name, email, role_label } = req.body;

    if (!name || !email) {
      return res.status(400).json({ message: "name and email are required" });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    const recipientId = randomUUID();

    await pool.query<ResultSetHeader>(
      `INSERT INTO notification_recipients (recipient_id, name, email, role_label, is_active)
       VALUES (?, ?, ?, ?, 1)`,
      [recipientId, name, email, role_label ?? null]
    );

    res.status(201).json({
      message: "Recipient added",
      data: { recipient_id: recipientId, name, email, role_label: role_label ?? null, is_active: 1 },
    });
  } catch (error: any) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "This email is already registered" });
    }
    console.error("[createNotificationRecipient] Error:", error);
    res.status(500).json({ message: "Failed to add recipient" });
  }
};

export const updateRecipientStatus = async (req: Request, res: Response) => {
  try {
    const { recipient_id } = req.params;
    const { is_active } = req.body;

    if (typeof is_active !== "boolean") {
      return res.status(400).json({ message: "is_active must be true or false" });
    }

    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE notification_recipients SET is_active = ? WHERE recipient_id = ?`,
      [is_active ? 1 : 0, recipient_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Recipient not found" });
    }

    res.status(200).json({ message: "Recipient status updated" });
  } catch (error: any) {
    console.error("[updateRecipientStatus] Error:", error);
    res.status(500).json({ message: "Failed to update recipient" });
  }
};

export const deleteNotificationRecipient = async (req: Request, res: Response) => {
  try {
    const { recipient_id } = req.params;

    const [result] = await pool.query<ResultSetHeader>(
      `DELETE FROM notification_recipients WHERE recipient_id = ?`,
      [recipient_id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Recipient not found" });
    }

    res.status(200).json({ message: "Recipient removed" });
  } catch (error: any) {
    console.error("[deleteNotificationRecipient] Error:", error);
    res.status(500).json({ message: "Failed to remove recipient" });
  }
};