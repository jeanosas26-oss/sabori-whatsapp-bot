// Sabori — bot de WhatsApp de Buenos Sabores Supermarket
// WhatsApp Cloud API de Meta (sin Twilio). Pensado como plantilla reutilizable para otros comercios:
// todo lo específico del local está en CONFIG y en variables de entorno.
require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

// ───────────────────────── CONFIG DEL COMERCIO ─────────────────────────
const CONFIG = {
  nombre: process.env.STORE_NAME || 'Buenos Sabores Supermarket & Drugstore',
  direccion: process.env.STORE_ADDRESS || 'Severo del Castillo y Durand, Los Corralitos, Mendoza',
  horarios: 'Lun a Sáb 8:30 a 00:00 · Dom y feriados 10:00 a 22:00',
  delivery: 'Retiro en el local o Uber Envíos: el cliente pide el Uber Envíos con el local como punto de retiro y paga el viaje directo a Uber.',
  pagos: 'Solo pagos electrónicos (Mercado Pago / transferencia). El link de pago se manda después de confirmar stock.',
  web: process.env.STORE_WEB || 'https://jeanosas26-oss.github.io/buenos-sabores/',
  catalogoUrl: process.env.CATALOG_URL || 'https://jeanosas26-oss.github.io/buenos-sabores/productos.json',
  // Productos que Sabori ofrece siempre (los precios salen del listado de la web)
  destacados: [
    { claves: ['HANDROLL'], titulo: 'HANDROLLS MENDOZA ROLL', nota: 'De viernes a domingo hay seguro. De lunes a jueves son por encargue: tomá el pedido y aclarale que el local le confirma el horario.' },
  ],
  // Las promos se leen solas de la web (tarjetas de promo con botón de carrito). Esto es solo respaldo.
  promosRespaldo: 'Consultá las promos vigentes en la web.',
};

// ───────────────────────── VARIABLES DE ENTORNO ─────────────────────────
// WA_TOKEN            token de acceso de Meta (permanente, de usuario del sistema)
// WA_PHONE_NUMBER_ID  ID del número en WhatsApp Manager
// WA_VERIFY_TOKEN     palabra secreta que elegís vos para verificar el webhook
// ANTHROPIC_API_KEY   clave de Claude
// STAFF_WHATSAPP      números que reciben los avisos, separados por coma (ej 5492613906605). No puede ser el mismo número del bot.
// DATABASE_URL        (opcional) Postgres para guardar pedidos. Sin esto, se guardan en memoria.
// ADMIN_API_KEY       clave para /api/admin/*
// WA_WABA_ID          ID de la cuenta de WhatsApp Business (para suscribir la app al arrancar)
// WA_PIN              PIN de 6 dígitos de verificación en dos pasos (para registrar el número al arrancar)
const { WA_TOKEN, WA_PHONE_NUMBER_ID, WA_VERIFY_TOKEN, STAFF_WHATSAPP, ADMIN_API_KEY } = process.env;
const GRAPH = 'https://graph.facebook.com/v25.0';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';

const app = express();
app.use(express.json());
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ───────────────────────── PEDIDOS (Postgres opcional) ─────────────────────────
let db = null;
const pedidosMem = [];
async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('Sin DATABASE_URL: pedidos en memoria'); return; }
  const { Pool } = require('pg');
  try {
    db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
    db.on('error', (e) => console.error('DB', e.message));
    await db.query(`CREATE TABLE IF NOT EXISTS pedidos (id SERIAL PRIMARY KEY, cliente TEXT NOT NULL, telefono TEXT NOT NULL, items TEXT NOT NULL, total TEXT, zona TEXT, entrega TEXT, estado TEXT DEFAULT 'recibido', created_at TIMESTAMP DEFAULT NOW())`);
    await db.query('ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS entrega TEXT');
    console.log('Base de datos lista');
  } catch (e) {
    console.error('No se pudo conectar a la base, sigo con pedidos en memoria:', e.message);
    db = null;
  }
}
async function guardarPedido(p) {
  if (db) {
    const r = await db.query('INSERT INTO pedidos (cliente, telefono, items, total, zona, entrega) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [p.cliente, p.telefono, p.items, p.total, p.zona, p.entrega]);
    return r.rows[0].id;
  }
  const id = pedidosMem.length + 1;
  pedidosMem.unshift({ id, ...p, estado: 'recibido', created_at: new Date().toISOString() });
  return id;
}

// ───────────────────────── CATÁLOGO ─────────────────────────
let catalogo = [];
let catalogoTs = 0;
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
async function cargarCatalogo() {
  if (Date.now() - catalogoTs < 10 * 60 * 1000 && catalogo.length) return;
  try {
    const r = await fetch(CONFIG.catalogoUrl, { timeout: 10000 });
    const data = await r.json();
    catalogo = (Array.isArray(data) ? data : data.productos || [])
      .filter((p) => p.nom && Number(p.pre) > 0)
      .map((p) => ({ nom: p.nom, pre: Number(p.pre), sto: Number(p.sto), ofe: p.ofe === 'si', key: norm(p.nom) }));
    catalogoTs = Date.now();
    console.log(`Catálogo: ${catalogo.length} productos`);
  } catch (e) { console.error('No se pudo cargar el catálogo', e.message); }
}
// ───────────────────────── PROMOS (leídas de la web) ─────────────────────────
let promos = '';
let promosTs = 0;
async function cargarPromos() {
  if (Date.now() - promosTs < 10 * 60 * 1000 && promos) return;
  try {
    const r = await fetch(CONFIG.web, { timeout: 15000 });
    const html = await r.text();
    const re = /agregarAlCarrito\('[^']*','([^']*)','Promos','([\d.]+)'\)/g;
    const lista = [];
    let m;
    while ((m = re.exec(html))) lista.push(`${m[1]} — $${Number(m[2]).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`);
    if (lista.length) { promos = lista.join('\n'); promosTs = Date.now(); console.log(`Promos: ${lista.length}`); }
  } catch (e) { console.error('No se pudieron leer las promos', e.message); }
}

const STOP = new Set('de la el los las un una y o con sin para por que quiero tenes tienen hay me mi al del en a precio cuanto sale vale'.split(' '));
function buscar(texto, max = 25) {
  const palabras = norm(texto).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
  if (!palabras.length) return [];
  return catalogo
    .map((p) => ({ p, s: palabras.reduce((a, w) => a + (p.key.includes(w) ? 1 : 0), 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.p.sto > 0) - (a.p.sto > 0))
    .slice(0, max)
    .map(({ p }) => `${p.nom} — $${p.pre.toLocaleString('es-AR')}${p.sto > 0 ? '' : ' (consultar stock)'}`);
}

function destacados() {
  return CONFIG.destacados.map((g) => {
    const items = catalogo.filter((p) => g.claves.some((k) => p.key.includes(norm(k))))
      .map((p) => `${p.nom} — $${p.pre.toLocaleString('es-AR')}`);
    return items.length ? `${g.titulo} (${g.nota})\n${items.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}

function prompt(resultados) {
  return `Sos Sabori, el vendedor por WhatsApp de ${CONFIG.nombre} (${CONFIG.direccion}).
Horarios: ${CONFIG.horarios}
Entrega: ${CONFIG.delivery}
Pagos: ${CONFIG.pagos}
Web con todo el catálogo: ${CONFIG.web}

PROMOS VIGENTES (estas son las únicas promos, con su precio exacto):
${promos || CONFIG.promosRespaldo}

DESTACADOS PARA OFRECER (sugerilos cuando venga al caso, por ejemplo al saludar o si piden algo para comer):
${destacados() || '(ninguno)'}

PRODUCTOS DEL CATÁLOGO QUE COINCIDEN CON LO QUE PIDE EL CLIENTE:
${resultados.length ? resultados.join('\n') : '(ninguno encontrado para este mensaje — si pide algo, pedile que lo describa distinto o mandalo a la web)'}

CÓMO VENDER:
- Español argentino, con "vos", cálido y corto (mensajes de WhatsApp, no párrafos largos).
- Sé vendedor activo: sugerí promos y productos complementarios, pero sin insistir.
- Usá SOLO precios de la lista de arriba. Nunca inventes productos ni precios.
- Aclarale que el stock se confirma antes de mandar el link de pago.
- Tomá el pedido completo: productos y cantidades, nombre, si retira o usa Uber Envíos, y dirección si corresponde.
- Antes de cerrar, repetí el resumen y pedí confirmación. Cuando el cliente confirme, agregá al final esta etiqueta exacta (el cliente no la ve):
[PEDIDO_CONFIRMADO]
Cliente: nombre
Pedido: lista de productos con cantidades
Entrega: Retiro o Uber Envíos
Zona: dirección o "Retira"
Total: monto estimado
[/PEDIDO_CONFIRMADO]`;
}

// ───────────────────────── WHATSAPP CLOUD API ─────────────────────────
async function enviar(to, texto) {
  const r = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: texto.slice(0, 4096) } }),
  });
  if (!r.ok) console.error('Error enviando a', to, await r.text());
}
// Al arrancar: registra el número en la Cloud API y suscribe la app a la cuenta de WhatsApp.
// Son idempotentes: si ya está hecho, Meta responde OK o un error inofensivo.
async function activarNumero() {
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) return console.log('Faltan WA_TOKEN / WA_PHONE_NUMBER_ID');
  const h = { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' };
  if (process.env.WA_PIN) {
    const r = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/register`, { method: 'POST', headers: h, body: JSON.stringify({ messaging_product: 'whatsapp', pin: process.env.WA_PIN }) });
    console.log('Registro del número:', r.status, await r.text());
  }
  if (process.env.WA_WABA_ID) {
    const r = await fetch(`${GRAPH}/${process.env.WA_WABA_ID}/subscribed_apps`, { method: 'POST', headers: h });
    console.log('Suscripción de la app:', r.status, await r.text());
  }
}

async function marcarLeido(id) {
  fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: id }),
  }).catch(() => {});
}

// Verificación del webhook (Meta llama con GET una sola vez al configurarlo)
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === WA_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

const sesiones = new Map(); // tel -> { msgs, nombre, ts }
const vistos = new Set();   // evita procesar dos veces el mismo mensaje

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // Meta exige respuesta rápida; procesamos después
  const value = req.body?.entry?.[0]?.changes?.[0]?.value;
  const msg = value?.messages?.[0];
  if (!msg || vistos.has(msg.id)) return;
  vistos.add(msg.id);
  if (vistos.size > 5000) vistos.clear();
  procesar(msg, value.contacts?.[0]?.profile?.name).catch((e) => console.error(e));
});

async function procesar(msg, nombrePerfil) {
  const tel = msg.from;
  marcarLeido(msg.id);
  if (msg.type !== 'text') {
    return enviar(tel, '¡Hola! Por ahora leo solo mensajes de texto 🙌 Escribime qué necesitás y te ayudo con el pedido.');
  }
  const texto = msg.text.body;
  let s = sesiones.get(tel);
  if (!s || Date.now() - s.ts > 6 * 60 * 60 * 1000) s = { msgs: [], nombre: nombrePerfil || 'Cliente' };
  s.ts = Date.now();
  sesiones.set(tel, s);
  s.msgs.push({ role: 'user', content: texto });
  s.msgs = s.msgs.slice(-20);

  await Promise.all([cargarCatalogo(), cargarPromos()]);
  // busca con el mensaje actual + el anterior del cliente, para no perder el contexto
  const ultimos = s.msgs.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
  let respuesta;
  try {
    const r = await anthropic.messages.create({ model: MODEL, max_tokens: 800, system: prompt(buscar(ultimos)), messages: s.msgs });
    respuesta = r.content.find((c) => c.type === 'text')?.text || '';
  } catch (e) {
    console.error('Claude', e.message);
    return enviar(tel, `Uy, se me trabó el sistema un momento 🙏 Mirá todo el catálogo en ${CONFIG.web} o escribime de nuevo en un ratito.`);
  }
  s.msgs.push({ role: 'assistant', content: respuesta });

  const m = respuesta.match(/\[PEDIDO_CONFIRMADO\]([\s\S]*?)\[\/PEDIDO_CONFIRMADO\]/);
  if (m) {
    const get = (l) => (m[1].match(new RegExp(l + ':\\s*(.+)')) || [])[1]?.trim() || '';
    const p = { cliente: get('Cliente') || s.nombre, telefono: tel, items: get('Pedido'), entrega: get('Entrega'), zona: get('Zona'), total: get('Total') };
    const id = await guardarPedido(p).catch((e) => (console.error('DB', e.message), '?'));
    for (const staff of String(STAFF_WHATSAPP || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      await enviar(staff, `🛒 NUEVO PEDIDO #${id}\n\n👤 ${p.cliente}\n📱 +${tel}\n📋 ${p.items}\n🚚 ${p.entrega}\n📍 ${p.zona}\n💰 ${p.total}\n⏰ ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}\n\nConfirmá stock y mandale el link de pago.`);
    }
    sesiones.delete(tel);
  }
  const limpio = respuesta.replace(/\[PEDIDO_CONFIRMADO\][\s\S]*?\[\/PEDIDO_CONFIRMADO\]/g, '').trim();
  if (limpio) await enviar(tel, limpio);
}

// ───────────────────────── ADMIN ─────────────────────────
const admin = (req, res, next) => (ADMIN_API_KEY && req.headers['x-api-key'] === ADMIN_API_KEY ? next() : res.status(401).json({ error: 'No autorizado' }));
app.get('/api/admin/pedidos', admin, async (req, res) => {
  const pedidos = db ? (await db.query('SELECT * FROM pedidos ORDER BY created_at DESC LIMIT 100')).rows : pedidosMem.slice(0, 100);
  res.json({ ok: true, pedidos });
});
app.patch('/api/admin/pedidos/:id', admin, async (req, res) => {
  const { estado } = req.body;
  if (!['recibido', 'en_preparacion', 'listo', 'entregado', 'cancelado'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  if (db) await db.query('UPDATE pedidos SET estado=$1 WHERE id=$2', [estado, req.params.id]);
  else { const p = pedidosMem.find((x) => String(x.id) === req.params.id); if (p) p.estado = estado; }
  res.json({ ok: true });
});

app.get('/', (req, res) => res.json({ status: 'ok', bot: 'Sabori', comercio: CONFIG.nombre, productos: catalogo.length }));

module.exports = { buscar, destacados, cargarCatalogo, cargarPromos, _getPromos: () => promos, _setCatalogo: (c) => { catalogo = c; catalogoTs = Date.now(); } };
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDB().then(() => { cargarCatalogo(); cargarPromos(); activarNumero().catch((e) => console.error('activarNumero', e.message)); app.listen(PORT, () => console.log(`Sabori corriendo en puerto ${PORT}`)); })
    .catch((e) => { console.error(e); process.exit(1); });
}
