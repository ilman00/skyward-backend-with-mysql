import express from "express";
import { getTransactionSummary } from "../controllers/transactions.controller";
import { authenticate } from "../middlewares/authenticate";
import { authorize } from "../middlewares/authorize";      
const router = express.Router();

router.get("/transactions/summary", authenticate, authorize("admin", "staff"), getTransactionSummary);

export default router;