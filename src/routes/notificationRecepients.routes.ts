import express from "express";
import { authenticate } from "../middlewares/authenticate";
import { authorize } from "../middlewares/authorize";
import { getNotificationRecipients, createNotificationRecipient, updateRecipientStatus, deleteNotificationRecipient } from "../controllers/notificationRecipients.controller";

const router = express.Router();




// in your routes file
router.get("/notification-recipients", authenticate, authorize("admin"), getNotificationRecipients);
router.post("/notification-recipients", authenticate, authorize("admin"), createNotificationRecipient);
router.patch("/notification-recipients/:recipient_id/status", authenticate, authorize("admin"), updateRecipientStatus);
router.delete("/notification-recipients/:recipient_id", authenticate, authorize("admin"), deleteNotificationRecipient);

export default router;