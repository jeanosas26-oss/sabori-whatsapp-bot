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
    { claves: ['HANDROLL'], titulo: 'HANDROLLS MENDOZA ROLL', nota: 'Cada handroll equivale a unas 8 piezas de sushi, pero NO viene cortado: se come entero, en la mano, así es su presentación. De viernes a domingo hay seguro. De lunes a jueves son por encargue: tomá el pedido y aclarale que el local le confirma el horario.' },
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
// GROQ_API_KEY        (opcional) clave gratis de console.groq.com para escuchar audios
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
  if (Date.now() - catalogoTs < 5 * 60 * 1000 && catalogo.length) return;
  try {
    const r = await fetch(CONFIG.catalogoUrl, { timeout: 10000 });
    const data = await r.json();
    catalogo = (Array.isArray(data) ? data : data.productos || [])
      .filter((p) => p.nom && Number(p.pre) > 0 && !/^\s*promo/i.test(p.nom)) // las promos salen SOLO de la web
      .map((p) => ({ nom: p.nom, pre: Number(p.pre), sto: Number(p.sto), ofe: p.ofe === 'si', key: norm(p.nom) }));
    catalogoTs = Date.now();
    console.log(`Catálogo: ${catalogo.length} productos`);
  } catch (e) { console.error('No se pudo cargar el catálogo', e.message); }
}
// ───────────────────────── PROMOS (leídas de la web) ─────────────────────────
const sesiones = new Map(); // tel -> { msgs, nombre, ts }
let promos = '';
let promosTs = 0;
async function cargarPromos() {
  if (Date.now() - promosTs < 3 * 60 * 1000 && promos) return;
  try {
    const r = await fetch(CONFIG.web, { timeout: 15000 });
    const html = await r.text();
    const re = /agregarAlCarrito\('[^']*','([^']*)','Promos','([\d.]+)'\)/g;
    const lista = [];
    let m;
    while ((m = re.exec(html))) lista.push(`${m[1]} — $${Number(m[2]).toLocaleString('es-AR', { maximumFractionDigits: 2 })}`);
    if (lista.length) {
      const nuevas = lista.join('\n');
      if (promos && nuevas !== promos) { sesiones.clear(); console.log('Cambiaron las promos: reinicio conversaciones'); }
      promos = nuevas; promosTs = Date.now(); console.log(`Promos: ${lista.length}`);
    }
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
- Las ÚNICAS promos que existen son las de PROMOS VIGENTES. No ofrezcas ni inventes otras promos o combos.
- Al ofrecer una promo, decí siempre qué incluye y su precio tal como figura en PROMOS VIGENTES (si aclara precio en efectivo, decí ambos).
- Aclarale que el stock se confirma antes de mandar el link de pago.
- Si el cliente manda un AUDIO, vas a ver su transcripción: respondé normalmente como si lo hubiera escrito (no hace falta aclarar que era un audio).
- Si el cliente ESCRIBE una dirección de entrega, usá la herramienta ubicar_direccion, confirmale la dirección que encontraste y mandale el link del mapa para que verifique. En Zona del pedido poné la dirección y el link del mapa.
- Si manda su UBICACIÓN o un link de Google Maps, vas a ver la dirección descifrada en [UBICACIÓN DEL CLIENTE]: usá esa dirección para la entrega, confirmásela ("¿Te lo llevamos a ...?") y en Zona del pedido poné la dirección y el link del mapa.
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

// ───────────────────────── UBICACIÓN Y AUDIOS ─────────────────────────
async function textoDelMensaje(msg) {
  if (msg.type === 'text') {
    const body = msg.text.body;
    const link = body.match(/https?:\/\/\S*(maps\.app\.goo\.gl|goo\.gl\/maps|google\.[a-z.]+\/maps|maps\.google\.[a-z.]+)\S*/i);
    if (link) {
      const ub = await leerLinkMaps(link[0]).catch((e) => (console.error('Link maps', e.message), null));
      if (ub) return `${body}\n${ub}`;
    }
    return body;
  }
  if (msg.type === 'location') return await leerUbicacion(msg.location);
  if (msg.type === 'audio') {
    const t = await transcribirAudio(msg.audio.id).catch((e) => (console.error('Audio', e.message), null));
    return t ? `[AUDIO DEL CLIENTE, transcripto] ${t}` : '[El cliente mandó un audio que no se pudo escuchar. Pedile amablemente que lo escriba.]';
  }
  if (msg.type === 'button') return msg.button.text;
  if (msg.type === 'interactive') return msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || null;
  if (msg.type === 'image' && msg.image?.caption) return `[El cliente mandó una foto con este texto] ${msg.image.caption}`;
  return null;
}

// Convierte la ubicación de WhatsApp en una dirección (OpenStreetMap, gratis)
async function leerUbicacion(loc) {
  const { latitude: lat, longitude: lng } = loc;
  const mapa = `https://maps.google.com/?q=${lat},${lng}`;
  let dir = [loc.name, loc.address].filter(Boolean).join(', ');
  if (!dir) {
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=es&zoom=18`, {
        headers: { 'User-Agent': 'SaboriBot/1.0 (Buenos Sabores Supermarket, Mendoza)' }, timeout: 8000,
      });
      const j = await r.json();
      const a = j.address || {};
      dir = [[a.road, a.house_number].filter(Boolean).join(' '), a.neighbourhood || a.suburb, a.city || a.town || a.village || a.county]
        .filter(Boolean).join(', ') || j.display_name || '';
    } catch (e) { console.error('Ubicación', e.message); }
  }
  return `[UBICACIÓN DEL CLIENTE] ${dir || 'dirección no identificada'} — mapa: ${mapa}`;
}

// Descifra un link de Google Maps pegado como texto (corto o largo) y lo convierte en dirección
function coordsDeUrl(u) {
  const dec = decodeURIComponent(u);
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/, /\/(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/];
  for (const p of pats) { const m = dec.match(p); if (m) return { latitude: Number(m[1]), longitude: Number(m[2]) }; }
  return null;
}
async function leerLinkMaps(url) {
  let actual = url;
  for (let i = 0; i < 5 && !coordsDeUrl(actual); i++) {  // sigue las redirecciones del link corto
    const r = await globalThis.fetch(actual, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    const loc = r.headers.get('location');
    if (!loc) {
      const html = await r.text();
      const c = coordsDeUrl(html.slice(0, 200000));
      if (c) return leerUbicacion(c);
      // links tipo ?q=Calle+123 sin coordenadas: usar el texto como dirección
      const q = decodeURIComponent((actual.match(/[?&]q=([^&]+)/) || [])[1] || '').replace(/\+/g, ' ');
      if (q) { const d = await ubicarDireccion(q); return d.encontrada ? `[UBICACIÓN DEL CLIENTE] ${d.direccion} — mapa: ${d.mapa}` : null; }
      return null;
    }
    actual = new URL(loc, actual).toString();
  }
  const c = coordsDeUrl(actual);
  return c ? leerUbicacion(c) : null;
}

// Busca una dirección escrita (ej. "Severo del Castillo 5030") en el mapa de Mendoza (OpenStreetMap, gratis)
async function ubicarDireccion(texto) {
  const q = encodeURIComponent(`${texto}, Mendoza, Argentina`);
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${q}&countrycodes=ar&viewbox=-69.10,-32.70,-68.40,-33.20&bounded=1&limit=1&addressdetails=1&accept-language=es`, {
      headers: { 'User-Agent': 'SaboriBot/1.0 (Buenos Sabores Supermarket, Mendoza)' }, timeout: 8000,
    });
    const [x] = await r.json();
    if (!x) return { encontrada: false, nota: 'No encontré esa dirección en el mapa. Pedile al cliente una referencia (entre calles, barrio) o que mande su ubicación de WhatsApp.' };
    const a = x.address || {};
    const dir = [[a.road, a.house_number].filter(Boolean).join(' '), a.neighbourhood || a.suburb, a.city || a.town || a.village || a.county].filter(Boolean).join(', ');
    return { encontrada: true, direccion: dir || x.display_name, mapa: `https://maps.google.com/?q=${x.lat},${x.lon}`, numero_exacto: !!a.house_number };
  } catch (e) {
    console.error('Geocodificar', e.message);
    return { encontrada: false, nota: 'El mapa no respondió. Seguí con la dirección tal como la escribió el cliente.' };
  }
}

const HERRAMIENTAS = [{
  name: 'ubicar_direccion',
  description: 'Busca en el mapa una dirección que el cliente escribió (calle y número, esquina, barrio) en Mendoza y devuelve la dirección normalizada y un link de Google Maps. Usala siempre que el cliente escriba una dirección de entrega.',
  input_schema: { type: 'object', properties: { direccion: { type: 'string', description: 'La dirección tal como la escribió el cliente, ej. "Severo del Castillo 5030, Corralitos"' } }, required: ['direccion'] },
}];

// Descarga el audio de WhatsApp y lo pasa a texto con Groq (Whisper, gratis)
async function transcribirAudio(mediaId) {
  if (!process.env.GROQ_API_KEY) return null;
  const h = { Authorization: `Bearer ${WA_TOKEN}` };
  const meta = await (await fetch(`${GRAPH}/${mediaId}`, { headers: h })).json();
  if (!meta.url) throw new Error('sin url de audio');
  const audio = await (await fetch(meta.url, { headers: h })).buffer();
  const form = new FormData();
  form.append('file', new Blob([audio], { type: meta.mime_type || 'audio/ogg' }), 'audio.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('language', 'es');
  const r = await globalThis.fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` }, body: form,
  });
  if (!r.ok) throw new Error(`Groq ${r.status} ${await r.text()}`);
  const j = await r.json();
  console.log('Audio transcripto:', j.text?.slice(0, 80));
  return j.text?.trim() || null;
}

async function procesar(msg, nombrePerfil) {
  const tel = msg.from;
  marcarLeido(msg.id);
  const texto = await textoDelMensaje(msg);
  if (!texto) {
    return enviar(tel, '¡Hola! Ese tipo de mensaje no lo puedo ver 🙈 Escribime, mandame un audio o tu ubicación y te ayudo con el pedido.');
  }
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
    const system = prompt(buscar(ultimos));
    const conv = [...s.msgs];
    for (let paso = 0; paso < 4; paso++) {
      const r = await anthropic.messages.create({ model: MODEL, max_tokens: 900, system, tools: HERRAMIENTAS, messages: conv });
      const usos = r.content.filter((c) => c.type === 'tool_use');
      respuesta = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (r.stop_reason !== 'tool_use' || !usos.length) break;
      conv.push({ role: 'assistant', content: r.content });
      const resultados = [];
      for (const u of usos) {
        const out = u.name === 'ubicar_direccion' ? await ubicarDireccion(u.input.direccion) : { error: 'herramienta desconocida' };
        console.log('Dirección:', u.input.direccion, '→', out.direccion || out.nota);
        resultados.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      }
      conv.push({ role: 'user', content: resultados });
    }
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

module.exports = { buscar, destacados, textoDelMensaje, _procesar: (...a) => procesar(...a), cargarCatalogo, cargarPromos, _getPromos: () => promos, _setCatalogo: (c) => { catalogo = c; catalogoTs = Date.now(); } };
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDB().then(() => { cargarCatalogo(); cargarPromos(); activarNumero().catch((e) => console.error('activarNumero', e.message)); app.listen(PORT, () => console.log(`Sabori corriendo en puerto ${PORT}`)); })
    .catch((e) => { console.error(e); process.exit(1); });
}
