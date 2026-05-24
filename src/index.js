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
app.use(session({ secret: process.env.SESSION_SECRET || 'sabori-secret', resave: false, saveUninitialized: true }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

const TWILIO_FROM = 'whatsapp:+14155238886';
const STAFF_WHATSAPP = 'whatsapp:+542617617618';
const STORE_ADDRESS = 'Severo del Castillo y Durand, Mendoza';
const STORE_WHATSAPP = '2617617618';
const CATALOG_URL = 'https://buenos-sabores.netlify.app';
const sessions = {};

const PROMOS = `🌭 Promo Pancho Premium: 6 panes + 6 salchichas $8.499\n🍔 Promo Hamburguesas Premium: 2 pkts x2 + 1 pan gastronómico x4 $14.999\n🫙 Aceite Cocinero Girasol 1.5L $5.499\n🧀 Picada Perfecta 5 personas $12.900\n🍕 Super Promo Pizza: prepizza x3 + queso cremoso 500g + salsa 1kg $8.499`;

async function initDB() {
  await db.query(`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, cliente TEXT NOT NULL, telefono TEXT NOT NULL, items TEXT NOT NULL, total TEXT, zona TEXT, delivery TEXT DEFAULT 'A confirmar por el local', estado TEXT DEFAULT 'recibido', created_at TIMESTAMP DEFAULT NOW())`);
  console.log('Base de datos lista');
}

async function fetchCatalogo() {
  try {
    const res = await fetch(CATALOG_URL, { timeout: 8000 });
    const html = await res.text();
    const $ = cheerio.load(html);
    const vistos = new Set();
    const limpios = [];
    $('*').each((_, el) => {
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      if (text.includes('$') && text.length > 5 && text.length < 200) {
        const key = text.slice(0, 40);
        if (!vistos.has(key) && limpios.length < 40) { vistos.add(key); limpios.push(text); }
      }
    });
    return limpios.length > 0 ? limpios.join('\n') : 'Catálogo no disponible.';
  } catch (e) { return 'Catálogo no disponible.'; }
}

async function buildPrompt() {
  const catalogo = await fetchCatalogo();
  return `Sos Sabori, el asistente de ventas de Buenos Sabores Supermarket (${STORE_ADDRESS}, WhatsApp: ${STORE_WHATSAPP}).

CATALOGO ACTUAL:
${catalogo}

PROMOCIONES:
${PROMOS}

INSTRUCCIONES:
- Hablá en español argentino, amigable y directo
- Tomá el pedido, preguntá dirección/zona
- Informá siempre que el delivery lo confirma el local
- Cuando el cliente confirme el pedido usá esta etiqueta exacta:
[PEDIDO_CONFIRMADO]
Cliente: nombre
Pedido: lista de productos
Zona: dirección o zona
Total: monto o A calcular
Delivery: A confirmar por el local
[/PEDIDO_CONFIRMADO]`;
}

app.all('/api/whatsapp/webhook', async (req, res) => {
  if (req.method === 'GET') return res.status(200).send('OK');
  const { Body: msg, From: tel, ProfileName: nombre } = req.body;
  if (!msg || !tel) return res.status(400).send('Bad request');
  try {
    if (!sessions[tel]) sessions[tel] = { messages: [], nombre: nombre || 'Cliente' };
    const s = sessions[tel];
    if (nombre) s.nombre = nombre;
    s.messages.push({ role: 'user', content: msg });
    const prompt = await buildPrompt();
    const r = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: prompt, messages: s.messages });
    const texto = r.content[0].text;
    s.messages.push({ role: 'assistant', content: texto });
    if (texto.includes('[PEDIDO_CONFIRMADO]')) {
      const match = texto.match(/\[PEDIDO_CONFIRMADO\]([\s\S]*?)\[\/PEDIDO_CONFIRMADO\]/);
      const resumen = match ? match[1].trim() : '';
      const get = (label) => { const m = resumen.match(new RegExp(label + ':\\s*(.+)')); return m ? m[1].trim() : ''; };
      const cliente = get('Cliente') || s.nombre;
      const items = get('Pedido');
      const zona = get('Zona');
      const total = get('Total');
      await db.query(`INSERT INTO pedidos (cliente, telefono, items, total, zona) VALUES ($1,$2,$3,$4,$5)`, [cliente, tel, items, total, zona]);
      await twilioClient.messages.create({ from: TWILIO_FROM, to: STAFF_WHATSAPP, body: `🛒 NUEVO PEDIDO - Buenos Sabores Supermarket\n\n👤 ${cliente}\n📱 ${tel}\n📋 ${items}\n📍 ${zona || 'No especificada'}\n💰 ${total || 'A calcular'}\n🚚 Delivery: A confirmar\n⏰ ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}` });
      sessions[tel] = null;
    }
    const limpio = texto.replace(/\[PEDIDO_CONFIRMADO\][\s\S]*?\[\/PEDIDO_CONFIRMADO\]/g, '').trim();
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(limpio);
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (e) {
    console.error(e);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message('Ups, hubo un problema. Intentá de nuevo 🙏');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

app.get('/api/admin/dashboard', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'No autorizado' });
  const r = await db.query('SELECT * FROM pedidos ORDER BY created_at DESC LIMIT 100');
  res.json({ ok: true, pedidos: r.rows });
});

app.patch('/api/admin/pedidos/:id', async (req, res) => {
  if (req.headers['x-api-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'No autorizado' });
  const { estado } = req.body;
  if (!['recibido','en_preparacion','en_camino','entregado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  await db.query('UPDATE pedidos SET estado=$1 WHERE id=$2', [estado, req.params.id]);
  res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'Sabori - Buenos Sabores Supermarket' }));

const PORT = process.env.PORT || 3000;
initDB().then(() => app.listen(PORT, () => console.log(`Sabori corriendo en puerto ${PORT}`))).catch(e => { console.error(e); process.exit(1); });
