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
  delivery: 'Retiro en el local o Uber Envíos (no hay delivery propio): el cliente pide el Uber Envíos desde su app con el local como punto de retiro, y el costo, el viaje y el seguimiento los gestiona y paga él directo en Uber. Por lo general los envíos van en moto, así que si el pedido es grande o pesado sugerí dividirlo o pedir auto. Avisá que con lluvia, viento zonda o mal clima puede haber demoras largas.',
  alias: 'jeanosas.mp',
  titular: 'JEANO SAS',
  pagos: 'Transferencia o Mercado Pago al alias del local (se lo mandamos cuando el local confirma el stock). Si retira en el local también puede pagar en efectivo.',
  web: process.env.STORE_WEB || 'https://jeanosas26-oss.github.io/buenos-sabores/',
  catalogoUrl: process.env.CATALOG_URL || 'https://jeanosas26-oss.github.io/buenos-sabores/productos.json',
  // Productos discontinuados: Sabori nunca los ofrece aunque vuelvan a aparecer en el listado
  excluir: ['ELBA', 'SANDWICH ESCOLAR', 'ESCOLAR VIENA'],
  // Productos que Sabori ofrece siempre (los precios salen del listado de la web)
  destacados: [
    { claves: ['FIAMBRERIA X KG'], titulo: 'FIAMBRERÍA AL CORTE (precios POR KILO)', nota: 'Estos son los precios correctos de fiambres y quesos al corte: usá SIEMPRE estos y no otros precios de fiambre del catálogo (hormas o piezas enteras). Se pueden pedir por gramos: calculá proporcional al kilo y redondeá (ej. 250 g de un fiambre de $20.000/kg = $5.000). Aclarale que el peso final puede variar un poco al cortar.' },
    { claves: ['HANDROLL'], titulo: 'HANDROLLS MENDOZA ROLL', nota: 'Cada handroll equivale a unas 8 piezas de sushi, pero NO viene cortado: se come entero, en la mano, así es su presentación. SIEMPRE se encargan con al menos UN DÍA de anticipación, porque se preparan en el momento para que lleguen frescos y recién hechos (no hay handrolls para el mismo día). Explicalo con buena onda y como algo positivo, por ejemplo: "Los handrolls los hacemos por encargue, recién hechos para que te lleguen súper frescos 🍣. Pedilos con al menos un día de anticipación: ¿para qué día y horario los querés?". Tomá el pedido con el día y el horario y aclarale que el local se lo confirma. Si lo quiere para hoy, explicale amablemente que no llegamos y ofrecele dejarlo encargado para mañana.' },
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
    await db.query('CREATE TABLE IF NOT EXISTS avisos_pendientes (id SERIAL PRIMARY KEY, staff TEXT NOT NULL, texto TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW())');
    await db.query('CREATE TABLE IF NOT EXISTS staff_visto (tel TEXT PRIMARY KEY, ts TIMESTAMP)');
    const v = await db.query("SELECT tel, ts FROM staff_visto WHERE ts > NOW() - INTERVAL '24 hours'");
    for (const r of v.rows) ultimoMensaje.set(r.tel, new Date(r.ts).getTime());
    console.log('Base de datos lista');
  } catch (e) {
    console.error('No se pudo conectar a la base, sigo con pedidos en memoria:', e.message);
    db = null;
  }
}
const pedidosPendientes = new Map(); // id -> pedido esperando confirmación del local
async function guardarPedido(p) {
  const id = await guardarPedidoDB(p);
  pedidosPendientes.set(String(id), { id, ...p, ts: Date.now() });
  return id;
}
async function guardarPedidoDB(p) {
  if (db) {
    const r = await db.query('INSERT INTO pedidos (cliente, telefono, items, total, zona, entrega) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [p.cliente, p.telefono, p.items, p.total, p.zona, p.entrega]);
    return r.rows[0].id;
  }
  const id = (pedidosMem[0]?.id || 0) + 1;
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
      .filter((p) => p.nom && Number(p.pre) > 0 && !/^\s*promo/i.test(p.nom) && !CONFIG.excluir.some((x) => new RegExp(`(^|[^a-z0-9])${norm(x)}([^a-z0-9]|$)`).test(norm(p.nom)))) // las promos salen SOLO de la web
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

const STOP = new Set('de la el los las un una y o con sin para por que quiero tenes tienen hay me mi al del en a precio cuanto sale vale hola buenas dame mandame necesito queria quisiera algo unos unas'.split(' '));
// sinónimos y diminutivos comunes
const SINON = { bomboncito: 'bombon', bomboncitos: 'bombon', bombones: 'bombon', galletita: 'galleta', galletitas: 'galleta', gaseosa: 'coca', medialuna: 'medialuna', facturas: 'factura', fiambre: 'fiambreria', birra: 'cerveza', birras: 'cerveza', vino: 'vino', bonobon: 'bon' };
const UNIDADES = /^(\d+(?:[.,]\d+)?)(g|gr|grs|gramos|kg|kilo|kilos|ml|cc|l|lt|lts|litro|litros|u|un|uni|unid|x)?$/;
const tokens = (t) => norm(t).replace(/(\d)\s+(g|gr|grs|gramos|kg|ml|cc|l|lt|lts|litros?)\b/g, '$1$2').split(/[^a-z0-9.,]+/).map((w) => w.replace(/^[.,]+|[.,]+$/g, '')).filter(Boolean);
function claveTok(w) {
  const m = w.match(UNIDADES);
  if (m) return { num: m[1].replace(',', '.') };
  const base = SINON[w] || w;
  return { pal: base.length > 5 ? base.replace(/(es|s)$/, '') : base };
}
function buscar(texto, max = 30) {
  const q = [...new Set(tokens(texto))].filter((w) => !STOP.has(w) && (w.length > 1 || /\d/.test(w))).map(claveTok);
  if (!q.length) return [];
  return catalogo
    .map((p) => {
      const pw = (p.toks ||= tokens(p.nom).map(claveTok));
      let s = 0;
      for (const t of q) {
        if (t.num) { if (pw.some((x) => x.num === t.num)) s += 2; continue; }
        if (t.pal.length < 2) continue;
        if (pw.some((x) => x.pal && (x.pal === t.pal))) s += 3;
        else if (t.pal.length >= 4 && pw.some((x) => x.pal && (x.pal.startsWith(t.pal) || t.pal.startsWith(x.pal) && x.pal.length >= 4))) s += 2;
      }
      return { p, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (b.p.sto > 0) - (a.p.sto > 0))
    .slice(0, max)
    .map(({ p }) => `${p.nom} — $${Math.round(p.pre).toLocaleString('es-AR')}${p.sto > 0 ? '' : ' (consultar stock)'}`);
}

function destacados() {
  return CONFIG.destacados.map((g) => {
    const items = catalogo.filter((p) => g.claves.some((k) => p.key.includes(norm(k))))
      .map((p) => `${p.nom} — $${Math.round(p.pre).toLocaleString('es-AR')}`);
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
- Cuando confirme el pedido, decile que el local revisa el stock y en unos minutos le llega por acá el total final y los datos para pagar. NO le pases el alias ni datos de pago vos: eso lo manda el sistema cuando el local confirma.
- Si el cliente manda un comprobante de pago, agradecele y decile que el local lo verifica.
- Si el cliente manda un AUDIO, vas a ver su transcripción: respondé normalmente como si lo hubiera escrito (no hace falta aclarar que era un audio).
- Si el cliente ESCRIBE una dirección de entrega, usá la herramienta ubicar_direccion, confirmale la dirección que encontraste y mandale el link del mapa para que verifique. En Zona del pedido poné la dirección y el link del mapa.
- Si manda su UBICACIÓN o un link de Google Maps, vas a ver la dirección descifrada en [UBICACIÓN DEL CLIENTE]: usá esa dirección para la entrega, confirmásela ("¿Te lo llevamos a ...?") y en Zona del pedido poné la dirección y el link del mapa.
- Tomá el pedido completo: productos y cantidades, NOMBRE Y APELLIDO del cliente, si retira o usa Uber Envíos, y dirección si corresponde.
- OBLIGATORIO: antes de cerrar el pedido preguntá "¿A nombre de quién lo preparamos?" si el cliente todavía no te dijo su nombre. Nunca confirmes un pedido sin nombre.
- Antes de cerrar, repetí el resumen y pedí confirmación. Cuando el cliente confirme, agregá al final esta etiqueta exacta (el cliente no la ve):
[PEDIDO_CONFIRMADO]
Cliente: nombre y apellido que te dio el cliente
Pedido: lista de productos con cantidades
Entrega: Retiro o Uber Envíos
Zona: dirección o "Retira"
Total: monto estimado
[/PEDIDO_CONFIRMADO]

DERIVAR A UNA PERSONA DEL LOCAL (casi nunca):
- Vos resolvés TODO: precios, stock, promos, horarios, entregas, direcciones, pagos, recomendaciones, pedidos. Si un producto no aparece, ofrecé alternativas parecidas antes de rendirte. Nunca derives por algo que podés contestar.
- Derivá SOLO en estos casos: un reclamo o problema con un pedido ya hecho (faltó algo, llegó mal, cobro equivocado); un pago que el cliente dice haber hecho y hay que verificar; pedidos grandes, mayoristas o para eventos que necesitan un precio especial; factura A o datos fiscales; el cliente pide explícitamente hablar con una persona; o algo que de verdad no sabés y no está en tu información.
- Cuando derives, decile al cliente algo como: "Te paso con una persona del local 🙌 En un ratito te escribe por WhatsApp." y agregá al final esta etiqueta (el cliente no la ve):
[DERIVAR]
Motivo: en pocas palabras, qué necesita el cliente
[/DERIVAR]`;
}

// ───────────────────────── WHATSAPP CLOUD API ─────────────────────────
async function enviar(to, texto) {
  const r = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: texto.slice(0, 4096) } }),
  });
  if (!r.ok) { const t = await r.text(); console.error('Error enviando a', to, t); return false; }
  const j = await r.json().catch(() => ({}));
  return j?.messages?.[0]?.id || true;
}

// Aviso al personal: primero mensaje común (gratis si escribieron en las últimas 24 h);
// si WhatsApp no lo deja, usa la plantilla aprobada "aviso_pedido_staff".
const corto = (v, n = 900) => String(v || '-').replace(/[\n\t]+/g, ' ').replace(/ {4,}/g, '   ').slice(0, n);
const ultimoMensaje = new Map(); // tel -> última vez que nos escribió (ventana de 24 h de WhatsApp)
// Avisos al personal que WhatsApp no pudo entregar (ventana de 24 h vencida): se reenvían apenas el personal escribe.
const avisosPendientes = new Map(); // staff -> [textos]
const enviadosStaff = new Map();    // id del mensaje de WhatsApp -> { staff, texto }
function encolarAviso(staff, texto) {
  const l = avisosPendientes.get(staff) || [];
  if (!l.includes(texto)) l.push(texto);
  avisosPendientes.set(staff, l.slice(-20));
  if (db) db.query('INSERT INTO avisos_pendientes (staff, texto) VALUES ($1,$2)', [staff, texto]).catch((e) => console.error('DB aviso', e.message));
}
async function entregarPendientes(staff) {
  let l = avisosPendientes.get(staff) || [];
  if (db) {
    try { const r = await db.query('DELETE FROM avisos_pendientes WHERE staff=$1 RETURNING texto', [staff]); l = [...new Set([...l, ...r.rows.map((x) => x.texto)])]; } catch (e) { console.error('DB aviso', e.message); }
  }
  avisosPendientes.delete(staff);
  if (!l.length) return false;
  await enviar(staff, `📬 Tenés ${l.length} aviso(s) que no te pude entregar antes (WhatsApp los bloquea si no le escribís al bot en 24 h):`);
  for (const t of l) await enviar(staff, t);
  return true;
}
async function guardarVisto(tel) {
  if (db) db.query('INSERT INTO staff_visto (tel, ts) VALUES ($1, NOW()) ON CONFLICT (tel) DO UPDATE SET ts = NOW()', [tel]).catch(() => {});
}
async function avisarStaff(staff, texto, p, tel) {
  // Si el número del personal nos escribió en las últimas 24 h, el mensaje común es gratis y llega seguro.
  const visto = ultimoMensaje.get(staff);
  if (visto && Date.now() - visto < 23.5 * 60 * 60 * 1000) { const id = await enviar(staff, texto); if (id && id !== true) enviadosStaff.set(id, { staff, texto }); else if (!id) encolarAviso(staff, texto); return; }
  // Si no, WhatsApp exige una plantilla aprobada.
  const r = await fetch(`${GRAPH}/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to: staff, type: 'template',
      template: { name: process.env.WA_TEMPLATE_AVISO || 'aviso_pedido_staff', language: { code: 'es_AR' }, components: [{ type: 'body', parameters: [
        corto(p.cliente, 60), corto('+' + tel, 30), corto(p.items), corto(`${p.entrega} ${p.zona}`, 400), corto(p.total, 40),
      ].map((text) => ({ type: 'text', text })) }] },
    }),
  });
  if (r.ok) { const j = await r.json().catch(() => ({})); const id = j?.messages?.[0]?.id; if (id) enviadosStaff.set(id, { staff, texto }); return; }
  console.error('Plantilla no disponible, mando texto común:', (await r.text()).slice(0, 200));
  const id = await enviar(staff, texto);
  if (id && id !== true) enviadosStaff.set(id, { staff, texto }); else encolarAviso(staff, texto);
  if (enviadosStaff.size > 2000) enviadosStaff.clear();
}
// Al arrancar: registra el número en la Cloud API y suscribe la app a la cuenta de WhatsApp.
// Son idempotentes: si ya está hecho, Meta responde OK o un error inofensivo.
async function activarNumero() {
  if (!WA_TOKEN || !WA_PHONE_NUMBER_ID) return console.log('Faltan WA_TOKEN / WA_PHONE_NUMBER_ID');
  const h = { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' };
  // El número ya quedó registrado. Solo se vuelve a registrar si se pide (evita el límite de intentos de Meta).
  if (process.env.WA_PIN && process.env.WA_REGISTRAR === '1') {
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
  for (const st of value?.statuses || []) if (st.status === 'failed') {
    console.error('WhatsApp no pudo entregar a', st.recipient_id, JSON.stringify(st.errors || []));
    const e = enviadosStaff.get(st.id);
    if (e) { encolarAviso(e.staff, e.texto); enviadosStaff.delete(st.id); }
  }
  const msg = value?.messages?.[0];
  if (!msg || vistos.has(msg.id)) return;
  vistos.add(msg.id);
  ultimoMensaje.set(msg.from, Date.now());
  if (esStaff(msg.from)) guardarVisto(msg.from);
  if (vistos.size > 5000) vistos.clear();
  const cuerpo = msg.text?.body || msg.button?.text || '';
  if (esCodigoVerificacion(cuerpo)) { reenviarCodigo(msg.from, value.contacts?.[0]?.profile?.name, cuerpo).catch((e) => console.error('Código', e.message)); return; }
  procesar(msg, value.contacts?.[0]?.profile?.name).catch((e) => console.error(e));
});

// Códigos de verificación (Instagram, Facebook, etc.) que llegan al número del bot: se reenvían al personal y el bot no responde.
const esCodigoVerificacion = (t) => !/postal|descuento|cup[oó]n|promo/i.test(t) && /(c[oó]digo|code|verificaci[oó]n|verification|confirmaci[oó]n)/i.test(t) && /\b\d{4,8}\b|\b\d{3}[ -]\d{3}\b/.test(t);
async function reenviarCodigo(de, nombre, texto) {
  console.log('Código de verificación recibido de', de, '→ reenviado al personal');
  const aviso = `🔐 Llegó un código de verificación al número del bot\nDe: ${nombre || ''} +${de}\n\n${texto}`;
  for (const staff of String(STAFF_WHATSAPP || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    await avisarStaff(staff, aviso, { cliente: 'CÓDIGO DE VERIFICACIÓN', items: texto, entrega: 'Mensaje de', zona: nombre || '', total: '-' }, de);
  }
}

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

// ───────────────────────── CONFIRMACIÓN DEL LOCAL Y COBRO ─────────────────────────
const esStaff = (tel) => String(STAFF_WHATSAPP || '').split(',').map((x) => x.trim()).includes(tel);
const plata = (n) => '$' + Math.round(Number(n)).toLocaleString('es-AR');
function datosDePago(total) {
  const alias = process.env.MP_ALIAS || CONFIG.alias;
  const titular = process.env.MP_TITULAR || CONFIG.titular;
  if (!alias) return 'El local te va a pasar los datos de pago en un momento 🙏';
  return `💳 *Para pagar:* transferí ${total ? `*${total}*` : 'el total'} por Mercado Pago o desde tu banco al alias:\n\n*${alias}*${titular ? `\n(a nombre de ${titular})` : ''}\n\nCuando pagues, mandame la foto del comprobante por acá y listo 🙌`;
}
async function comandoStaff(tel, texto) {
  const t = texto.trim();
  const m = t.match(/^(ok|listo|confirmado|confirmo|si|sí)\s*#?\s*(\d+)\b\s*(.*)$/is);
  const c = t.match(/^(no|cancelar|cancelado|anular)\s*#?\s*(\d+)\b\s*(.*)$/is);
  if (!m && !c) {
    return enviar(tel, '👋 Hola equipo. Para confirmar un pedido respondé:\n• *ok 12* → hay todo, le mando el total y el alias al cliente\n• *ok 12 sin coca* → le aviso el cambio y ajusto el total\n• *ok 12 total 15000* → confirmo con ese total\n• *no 12 motivo* → cancelo y le aviso al cliente\n• *pedidos* → te muestro los pedidos pendientes');
  }
  const id = (m || c)[2];
  const p = pedidosPendientes.get(id);
  if (!p) return enviar(tel, `No encuentro el pedido #${id} pendiente 🤔 (puede que ya esté confirmado o que el sistema se haya reiniciado). Escribile al cliente directo si hace falta.`);
  const nota = ((m || c)[3] || '').trim();
  if (c) {
    pedidosPendientes.delete(id);
    await enviar(p.telefono, `Hola ${p.cliente} 😔 Lamentablemente no podemos preparar tu pedido #${id}${nota ? `: ${nota}` : ''}. ¿Querés que te ofrezca otra cosa?`);
    return enviar(tel, `❌ Pedido #${id} cancelado y avisado al cliente.`);
  }
  let total = p.total;
  let detalle = '';
  const totalExplicito = nota.match(/total\s*\$?\s*([\d.,]+)/i);
  if (totalExplicito) {
    total = plata(totalExplicito[1].replace(/\./g, '').replace(',', '.'));
    detalle = nota.replace(totalExplicito[0], '').trim();
  } else if (nota) {
    // Ajuste en palabras ("sin coca", "faltan 2 medialunas"): Claude recalcula el total
    try {
      await cargarCatalogo();
      const r = await anthropic.messages.create({
        model: MODEL, max_tokens: 300,
        system: 'Ajustás pedidos de un supermercado. Respondé SOLO un JSON {"total": número, "explicacion": "texto corto para el cliente"} sin nada más.',
        messages: [{ role: 'user', content: `Pedido original: ${p.items}\nTotal original: ${p.total}\nCambio indicado por el local: ${nota}\nPrecios de referencia:\n${buscar(p.items + ' ' + nota, 25).join('\n')}\nCalculá el nuevo total.` }],
      });
      const j = JSON.parse((r.content.find((x) => x.type === 'text')?.text || '{}').match(/\{[\s\S]*\}/)[0]);
      if (j.total) total = plata(j.total);
      detalle = j.explicacion || nota;
    } catch (e) { console.error('Ajuste', e.message); detalle = nota; }
  }
  pedidosPendientes.delete(id);
  await enviar(p.telefono, `✅ ¡Listo ${p.cliente}! Tu pedido #${id} está confirmado.${detalle ? `\n📝 ${detalle}` : ''}\n💰 *Total: ${total}*\n\n${datosDePago(total)}`);
  return enviar(tel, `✅ Pedido #${id} confirmado. Le mandé al cliente el total (${total}) y el alias.`);
}

async function procesar(msg, nombrePerfil) {
  const tel = msg.from;
  marcarLeido(msg.id);
  if (esStaff(tel)) await entregarPendientes(tel).catch((e) => console.error('pendientes', e.message));
  if (esStaff(tel) && msg.type === 'text') {  // el personal usa el bot para confirmar pedidos
    if (/^(pedidos|pendientes)$/i.test(msg.text.body.trim())) {
      const l = [...pedidosPendientes.values()];
      return enviar(tel, l.length ? '🧾 Pedidos esperando confirmación:\n\n' + l.map((p) => `#${p.id} · ${p.cliente} · +${p.telefono}\n📋 ${p.items}\n💰 ${p.total}`).join('\n\n') : '✅ No hay pedidos pendientes.');
    }
    return comandoStaff(tel, msg.text.body);
  }
  if (!esStaff(tel) && (msg.type === 'image' || msg.type === 'document')) {
    const mio = [...pedidosPendientes.values(), ...pedidosMem].find((x) => x.telefono === tel);
    if (mio) {  // tiene un pedido: lo más probable es que sea el comprobante
      for (const staff of String(STAFF_WHATSAPP || '').split(',').map((x) => x.trim()).filter(Boolean)) {
        await enviar(staff, `🧾 El cliente +${tel} (pedido #${mio.id}) mandó una foto/archivo, probablemente el comprobante. Verificá el pago en Mercado Pago.\n👉 https://wa.me/${tel}`);
      }
      if (!msg.image?.caption) return enviar(tel, '¡Gracias! 🙌 Ya le paso el comprobante al local para que lo verifique.');
    } else if (!msg.image?.caption) {  // sin pedido: suele ser captura de un anuncio o de un producto
      return enviar(tel, '¡Gracias por la foto! 🙌 No llego a verla bien desde acá. ¿Me contás qué producto o promo te interesa y te paso precio y disponibilidad?');
    }
  }
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
    const nomOk = (n) => n && !/^(nombre|cliente|-|sin nombre|n\/a)/i.test(n.trim());
    const p = { cliente: nomOk(get('Cliente')) ? get('Cliente') : (nomOk(s.nombre) ? s.nombre + ' (perfil de WhatsApp)' : 'Sin nombre (ver chat)'), telefono: tel, items: get('Pedido'), entrega: get('Entrega'), zona: get('Zona'), total: get('Total') };
    const id = await guardarPedido(p).catch((e) => (console.error('DB', e.message), '?'));
    for (const staff of String(STAFF_WHATSAPP || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      await avisarStaff(staff, `🛒 NUEVO PEDIDO #${id}\n\n👤 ${p.cliente}\n📱 +${tel}\n📋 ${p.items}\n🚚 ${p.entrega}\n📍 ${p.zona}\n💰 ${p.total}\n⏰ ${new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza' })}\n\n👉 Revisá el stock y respondé acá:\n*ok ${id}* (hay todo) · *ok ${id} sin X* (falta algo) · *no ${id}* (cancelar)`, p, tel);
    }
    sesiones.delete(tel);
  }
  const der = respuesta.match(/\[DERIVAR\]([\s\S]*?)\[\/DERIVAR\]/);
  if (der) {
    const motivo = (der[1].match(/Motivo:\s*(.+)/) || [])[1]?.trim() || 'Consulta del cliente';
    const ultimosMsgs = s.msgs.filter((x) => x.role === 'user' && typeof x.content === 'string').slice(-3).map((x) => `• ${x.content.slice(0, 200)}`).join('\n');
    const p = { cliente: s.nombre, items: `ATENDER CLIENTE: ${motivo}`, entrega: 'Escribile al cliente:', zona: `wa.me/${tel}`, total: '-' };
    for (const staff of String(STAFF_WHATSAPP || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      await avisarStaff(staff, `🙋 CLIENTE PARA ATENDER\n\n👤 ${s.nombre}\n📱 +${tel}\n❓ ${motivo}\n\nÚltimos mensajes:\n${ultimosMsgs}\n\n👉 Escribile acá: https://wa.me/${tel}`, p, tel);
    }
    console.log('Derivado a asesor:', tel, motivo);
  }
  const limpio = respuesta.replace(/\[PEDIDO_CONFIRMADO\][\s\S]*?\[\/PEDIDO_CONFIRMADO\]/g, '').replace(/\[DERIVAR\][\s\S]*?\[\/DERIVAR\]/g, '').trim();
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

app.get('/', (req, res) => res.json({ status: 'ok', version: '2026-10-30c', bot: 'Sabori', comercio: CONFIG.nombre, productos: catalogo.length }));

module.exports = { buscar, destacados, textoDelMensaje, _procesar: (...a) => procesar(...a), cargarCatalogo, cargarPromos, _getPromos: () => promos, _setCatalogo: (c) => { catalogo = c; catalogoTs = Date.now(); } };
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  initDB().then(() => { cargarCatalogo(); cargarPromos(); activarNumero().catch((e) => console.error('activarNumero', e.message)); app.listen(PORT, () => console.log(`Sabori corriendo en puerto ${PORT}`)); })
    .catch((e) => { console.error(e); process.exit(1); });
}
