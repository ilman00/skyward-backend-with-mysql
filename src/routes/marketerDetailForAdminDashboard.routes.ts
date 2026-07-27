import { Router } from "express";
import { getMarketerDetails, getSmdRentHistory } from "../controllers/marketerDetailForAdminDashbboard.controller";
import { authenticate } from "../middlewares/authenticate";
import { authorize } from "../middlewares/authorize";

const router = Router();

router.get("/marketers/:id/details", authenticate, authorize("admin", "staff"), getMarketerDetails);
router.get("/smd-closings/:smdClosingId/rent-history", authenticate, getSmdRentHistory);
    
export default router;
