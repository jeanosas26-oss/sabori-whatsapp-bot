import { logger } from "./logger";

const SITE_URL = "https://buenos-sabores.netlify.app";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface Producto {
  nom: string;
  cat: string;
  pre: number;
  preA?: number;
  sto?: number;
  ofe?: string;
}

export interface Promo {
  titulo: string;
  precio: string;
  desc?: string;
}

interface CatalogData {
  productos: Producto[];
  promos: Promo[];
  fetchedAt: number;
}

let cache: CatalogData | null = null;

function parseArray<T>(html: string, varName: string): T[] {
  const pattern = new RegExp(
    `(?:const|let|var)\\s+${varName}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s*;\\s*\\n`,
  );
  const match = html.match(pattern);
  if (!match) return [];
  try {
    // The site uses JS object literal syntax (single quotes, unquoted keys)
    // which isn't valid JSON — evaluate it safely as a JS expression.
    // Source is our own trusted website, so this is acceptable.
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return ${match[1]};`);
    return fn() as T[];
  } catch {
    return [];
  }
}

export async function fetchCatalog(): Promise<CatalogData> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache;
  }

  try {
    const res = await fetch(SITE_URL, {
      headers: { "User-Agent": "BuenosSabores-Bot/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const html = await res.text();

    const productos = parseArray<Producto>(html, "DEMO");
    const promos = parseArray<Promo>(html, "PROMOS_DEMO");

    cache = { productos, promos, fetchedAt: now };
    logger.info(
      { productos: productos.length, promos: promos.length },
      "Catalog fetched from site",
    );
    return cache;
  } catch (err) {
    logger.warn({ err }, "Failed to fetch catalog from site — using cached or empty");
    return cache ?? { productos: [], promos: [], fetchedAt: 0 };
  }
}

export function formatCatalogForPrompt(data: CatalogData): string {
  const lines: string[] = [];

  if (data.promos.length > 0) {
    lines.push("PROMOCIONES VIGENTES:");
    data.promos.forEach((p, i) => {
      const desc = p.desc ? ` — ${p.desc}` : "";
      lines.push(`${i + 1}. ${p.titulo} ${p.precio}${desc}`);
    });
  }

  if (data.productos.length > 0) {
    lines.push("");
    lines.push("PRODUCTOS DISPONIBLES (con precios actuales):");

    const byCategory: Record<string, Producto[]> = {};
    for (const p of data.productos) {
      if (!byCategory[p.cat]) byCategory[p.cat] = [];
      byCategory[p.cat].push(p);
    }

    for (const [cat, items] of Object.entries(byCategory)) {
      lines.push(`\n${cat}:`);
      for (const item of items) {
        const precio = `$${Number(item.pre).toLocaleString("es-AR")}`;
        const oferta = item.ofe === "si" ? " 🔥 OFERTA" : "";
        const stock =
          item.sto !== undefined && item.sto <= 5 && item.sto > 0
            ? ` (stock bajo: ${item.sto})`
            : item.sto === 0
              ? " (sin stock)"
              : "";
        lines.push(`  - ${item.nom}: ${precio}${oferta}${stock}`);
      }
    }
  }

  return lines.join("\n");
}

export function invalidateCache(): void {
  cache = null;
}
