import { Router } from "express";
import { authenticate } from "../middlewares/authenticate"; // adjust to your actual path
import { authorize } from "../middlewares/authorize"; // adjust to your actual path
import { upload } from "../middlewares/upload.middleware";
import {
  listEmployees,
  listEmployeesForAdmin,
  getEmployeeBySlug,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
} from "../controllers/employee.controller";

const router = Router();

// ---- Public routes (consumed by the separate static site / QR codes) ----
router.get("/", listEmployees);
router.get("/slug/:slug", getEmployeeBySlug);

// ---- Staff/admin routes (consumed by the internal admin panel) ----
// NOTE: /admin must be registered before /:employee_id, otherwise Express
// matches "admin" as an employee_id value against the dynamic route.
router.get("/admin", authenticate, authorize("admin", "staff"), listEmployeesForAdmin);
router.get("/:employee_id", authenticate, authorize("admin", "staff"), getEmployeeById);
router.post(
  "/",
  authenticate,
  authorize("admin", "staff"),
  upload.single("photo"),
  createEmployee
);
router.put(
  "/:employee_id",
  authenticate,
  authorize("admin", "staff"),
  upload.single("photo"),
  updateEmployee
);
router.delete("/:employee_id", authenticate, authorize("admin", "staff"), deleteEmployee);

export default router;