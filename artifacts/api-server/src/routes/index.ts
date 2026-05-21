import { Router, type IRouter } from "express";
import healthRouter from "./health";
import whatsappRouter from "./whatsapp";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(whatsappRouter);
router.use(adminRouter);

export default router;
