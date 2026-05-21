import { Router, type IRouter, type Request, type Response } from "express";
import { invalidateCache, fetchCatalog } from "../lib/catalog";

const router: IRouter = Router();

const ADMIN_KEY = process.env.ADMIN_API_KEY;

function requireAdminKey(req: Request, res: Response): boolean {
  if (!ADMIN_KEY) return true;
  const provided =
    req.headers["x-admin-key"] ?? req.query["key"];
  if (provided !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.post("/admin/catalog/refresh", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  invalidateCache();
  const data = await fetchCatalog();
  res.json({
    message: "Catalog cache refreshed from site",
    productos: data.productos.length,
    promos: data.promos.length,
    fetchedAt: new Date(data.fetchedAt).toISOString(),
  });
});

router.get("/admin/catalog/status", async (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  const data = await fetchCatalog();
  res.json({
    productos: data.productos.length,
    promos: data.promos.length,
    fetchedAt: data.fetchedAt
      ? new Date(data.fetchedAt).toISOString()
      : null,
    source: "https://buenos-sabores.netlify.app",
    cacheTtlMinutes: 5,
  });
});

export default router;
