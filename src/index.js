require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'sabori-secret',
  resave: false,
  saveUninitialized: true
}));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const TWILIO_FROM    = 'whatsapp:+14155238886';
const STAFF_WHATSAPP = 'whatsapp:+542617617618';
const STORE_ADDRESS  = 'Severo del Castillo y Durand, Mendoza';
const STORE_WHATSAPP = '2617617618';
const CATALOG_URL    = 'https://buenos-sabores.netlify.app';

const sessions = {};

const PROMOS_FIJAS = `
🌭 Promo Pancho Premium: 6 panes + 6 salchichas → $8.499
🍔 Promo Hamburguesas Premium: 2 pkts hamburguesas x2 + 1 pan gastronómico x4 → $14.999
🫙 Oferta Aceite Cocinero Girasol 1.5L → $5.499
🧀 Picada Perfecta (5 personas) → $12.900
🍕 Super Promo Pizza: prepizza x3 + queso cremoso 500g + salsa 1kg → $8.499
`;

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente TEXT NOT NULL,
      telefono TEXT NOT NULL,
      items TEXT NOT NULL,
      total TEXT,
      zona TEXT,
      delivery TEXT DEFAULT 'A confirmar por el local',
      estado TEXT DEFAULT 'recibido',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('✅ Base de datos lista');
}

async function fetchCatalogo() {
  try {
    const res = await fetch(CATALOG_URL, { timeout: 8000 });
    const html = await res.text();
    const $ = cheerio.load(html);
    let productos = [];
    $('*').each((_, el) => {
      const text = $(el).text().trim();
      if (text.includes('$') && text.length > 5 && text.length < 200) {
        const linea = text.replace(/\s+/g, ' ').trim();
        if (!productos.includes(linea)) productos.push(linea);
      }
    });
    const vistos = new Set();
    const limpios = [];
    for (const p of productos) {
      const key = p.slice(0, 40);
      if (!vistos.has(key) && limpios.length < 40) {
        vistos.add(key);
        limpios.push(p);
      }
    }
    return limpios.length > 0 ? limpios.join('\n') : 'No se pudo cargar el catálogo.';
  } catch (err) {
    console.error('Error scraping:', err.message);
    return 'No se pudo cargar el catálogo.';
  }
}

async function buildSystemPrompt() {
  const catalogo = await fetchCatalogo();
  return `Sos Sabori 🛒, el asistente de ventas por WhatsApp de Buenos Sabores Supermarket.
Estás en ${STORE_ADDRESS}. WhatsApp del local: ${STORE_WHATSAPP}.

TU MISIÓN:
1. Saludar al cliente de forma amigable
2. Mostrar productos y promos cuando te los pidan
3. Tomar el pedido completo
4. Preguntar dirección/zona para el envío
5. Confirmar el pedido final con resumen

CATÁLOGO ACTUAL (desde la web del local):
${catalogo}

PROMOCIONES ESPECIALES:
${PROMOS_FIJAS}

DELIVERY:
- Preguntá siempre la dirección o zona del cliente
- Informá siempre: "El costo de delivery será confirmado por el local"

REGLAS:
- Hablá en español argentino, cálido y directo
- Usá emojis con moderación
- Si no tenés un producto, decí "Te consulto con el equipo"
- Cuando el cliente confirme el pedido, cerrá con esta etiqueta exacta:
[PEDIDO_CONFIRMADO]
Cliente: {nombre}
Pedido: {lista de productos}
Zona/Dirección: {dirección}
Total estimado: {total o "A calcular"}
Delivery: A confirmar por el local
[/PEDIDO_CONFIRMADO]`;
}

app.all('/api/whatsapp/webhook', async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('Webhook activo ✅');

  const { Body: mensaje, From: telefono, ProfileName: nombre } = req.body;
  if (!mensaje || !telefono) return res.status(400).send('Bad request');

  console.log(`📩 ${nombre || telefono}: ${mensaje}`);

  try {
    if (!sessions[telefon
