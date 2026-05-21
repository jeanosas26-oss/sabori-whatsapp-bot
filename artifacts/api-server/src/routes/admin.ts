import { Router, type IRouter, type Request, type Response } from "express";
import { invalidateCache, fetchCatalog } from "../lib/catalog";
import { getOrders } from "../lib/orderStore";

const router: IRouter = Router();

const ADMIN_KEY = process.env.ADMIN_API_KEY;

function requireAdminKey(req: Request, res: Response): boolean {
  if (!ADMIN_KEY) return true;
  const provided = req.headers["x-admin-key"] ?? req.query["key"];
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
    fetchedAt: data.fetchedAt ? new Date(data.fetchedAt).toISOString() : null,
    source: "https://buenos-sabores.netlify.app",
    cacheTtlMinutes: 5,
  });
});

router.get("/admin/orders", (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  res.json(getOrders());
});

router.get("/admin/dashboard", (req: Request, res: Response) => {
  if (!requireAdminKey(req, res)) return;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
});

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Buenos Sabores — Pedidos</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --red:#d41e1e;--red2:#a51212;--green:#1e7d34;
  --bg:#0d0d0d;--surface:#1a1a1a;--border:#2a2a2a;
  --text:#f0f0f0;--muted:#888;--yellow:#FFD600;
}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
header{background:var(--surface);border-bottom:3px solid var(--red);padding:1rem 1.5rem;
  display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.logo{font-size:1.3rem;font-weight:900;letter-spacing:2px;color:#fff}
.logo span{color:var(--red)}
.stats{display:flex;gap:1rem;flex-wrap:wrap}
.stat{background:var(--bg);border:1px solid var(--border);border-radius:8px;
  padding:.5rem 1rem;text-align:center;min-width:80px}
.stat-val{font-size:1.4rem;font-weight:900;color:var(--yellow)}
.stat-lbl{font-size:.65rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px}
.badge{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4cde7a;
  animation:pulse 2s infinite;margin-right:6px}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
main{padding:1.5rem;max-width:1200px;margin:0 auto}
.toolbar{display:flex;align-items:center;gap:.8rem;margin-bottom:1rem;flex-wrap:wrap}
.toolbar h2{font-size:1rem;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:1px;flex:1}
.btn{background:var(--red);color:#fff;border:none;padding:.5rem 1rem;border-radius:6px;
  font-weight:700;font-size:.8rem;cursor:pointer;transition:background .2s}
.btn:hover{background:var(--red2)}
.btn.ghost{background:transparent;border:1px solid var(--border);color:var(--muted)}
.btn.ghost:hover{border-color:var(--red);color:#fff}
.search{background:var(--surface);border:1px solid var(--border);border-radius:6px;
  padding:.45rem .8rem;color:var(--text);font-size:.85rem;outline:none;width:200px}
.search:focus{border-color:var(--red)}
.empty{text-align:center;padding:4rem 2rem;color:var(--muted)}
.empty-icon{font-size:3rem;margin-bottom:.8rem}
table{width:100%;border-collapse:collapse;font-size:.87rem}
thead tr{background:var(--surface);border-bottom:2px solid var(--border)}
th{padding:.75rem 1rem;text-align:left;font-size:.72rem;text-transform:uppercase;
  letter-spacing:1px;color:var(--muted);white-space:nowrap}
tbody tr{border-bottom:1px solid var(--border);transition:background .15s;cursor:pointer}
tbody tr:hover{background:rgba(212,30,30,.06)}
td{padding:.8rem 1rem;vertical-align:top}
.order-id{font-family:monospace;font-size:.75rem;color:var(--muted)}
.cliente{font-weight:700}
.phone{font-size:.78rem;color:var(--muted);margin-top:2px}
.zona{font-size:.78rem;color:var(--yellow)}
.items-list{font-size:.8rem;line-height:1.6}
.total{font-weight:900;font-size:1.05rem;color:var(--yellow)}
.pago{display:inline-block;background:rgba(30,125,52,.2);color:#7fffa0;
  border:1px solid rgba(30,125,52,.3);padding:2px 8px;border-radius:99px;
  font-size:.72rem;font-weight:700;text-transform:uppercase}
.envio{font-size:.75rem;color:var(--muted);margin-top:4px}
.time{font-size:.78rem;color:var(--muted)}
.modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);
  z-index:100;align-items:center;justify-content:center;padding:1rem}
.modal-bg.on{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;
  padding:1.8rem;max-width:500px;width:100%;max-height:90vh;overflow-y:auto}
.modal h3{font-size:1.1rem;font-weight:900;margin-bottom:1.2rem;color:#fff}
.modal-row{display:flex;gap:.5rem;margin-bottom:.7rem;font-size:.88rem}
.modal-row .lbl{color:var(--muted);min-width:90px;flex-shrink:0}
.modal-row .val{color:var(--text);font-weight:600}
.modal-items{margin:1rem 0;background:var(--bg);border-radius:8px;padding:.8rem 1rem}
.modal-item{display:flex;justify-content:space-between;padding:.3rem 0;
  border-bottom:1px solid var(--border);font-size:.85rem}
.modal-item:last-child{border:none}
.modal-total{display:flex;justify-content:space-between;padding:.6rem 0;
  font-weight:900;font-size:1rem;color:var(--yellow)}
.close-btn{background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer;float:right;margin-top:-4px}
.notas-box{background:var(--bg);border:1px solid var(--border);border-radius:6px;
  padding:.6rem .9rem;font-size:.83rem;color:var(--muted);margin-top:.5rem}
</style>
</head>
<body>
<header>
  <div class="logo">BUENOS <span>SABORES</span> &mdash; Pedidos</div>
  <div class="stats">
    <div class="stat"><div class="stat-val" id="s-total">0</div><div class="stat-lbl">Total</div></div>
    <div class="stat"><div class="stat-val" id="s-hoy">0</div><div class="stat-lbl">Hoy</div></div>
    <div class="stat"><div class="stat-val" id="s-monto">$0</div><div class="stat-lbl">Facturado</div></div>
  </div>
  <div style="color:var(--muted);font-size:.78rem"><span class="badge"></span>En vivo</div>
</header>
<main>
  <div class="toolbar">
    <h2>Pedidos recientes</h2>
    <input class="search" id="search" placeholder="Buscar cliente, zona..." oninput="renderTable()"/>
    <button class="btn ghost" onclick="refresh()">↻ Actualizar</button>
  </div>
  <div id="content"></div>
</main>

<div class="modal-bg" id="modal" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal-inner"></div>
</div>

<script>
let orders = [];

function fmtARS(n){return Number(n).toLocaleString('es-AR')}
function fmtTime(iso){
  return new Date(iso).toLocaleString('es-AR',{
    timeZone:'America/Argentina/Mendoza',
    day:'2-digit',month:'2-digit',
    hour:'2-digit',minute:'2-digit'
  });
}

async function refresh(){
  try{
    const r = await fetch(location.pathname.replace('/dashboard','/orders'));
    orders = await r.json();
    renderStats();
    renderTable();
  }catch(e){console.error(e)}
}

function renderStats(){
  document.getElementById('s-total').textContent = orders.length;
  const today = new Date().toDateString();
  const hoy = orders.filter(o=>new Date(o.receivedAt).toDateString()===today).length;
  document.getElementById('s-hoy').textContent = hoy;
  const monto = orders.reduce((s,o)=>s+o.total,0);
  document.getElementById('s-monto').textContent = '$'+fmtARS(monto);
}

function renderTable(){
  const q = document.getElementById('search').value.toLowerCase();
  const filtered = orders.filter(o=>
    !q ||
    o.order.cliente.toLowerCase().includes(q) ||
    (o.order.zonaEntrega||'').toLowerCase().includes(q) ||
    o.order.direccion.toLowerCase().includes(q) ||
    o.customerPhone.includes(q)
  );

  if(!filtered.length){
    document.getElementById('content').innerHTML =
      '<div class="empty"><div class="empty-icon">📭</div>' +
      (orders.length ? '<p>Sin resultados para esa búsqueda.</p>' : '<p>Aún no hay pedidos. Cuando llegue el primero aparecerá acá.</p>') +
      '</div>';
    return;
  }

  const rows = filtered.map(o=>{
    const items = o.order.items.map(i=>{
      const cant = i.cantidad>1 ? i.cantidad+'x ' : '';
      return cant+i.producto+' — $'+fmtARS(i.cantidad*i.precioUnit);
    }).join('<br>');
    return \`<tr onclick="openModal('\${o.id}')">
      <td><div class="time">\${fmtTime(o.receivedAt)}</div></td>
      <td>
        <div class="cliente">\${esc(o.order.cliente)}</div>
        <div class="phone">\${esc(o.customerPhone)}</div>
        \${o.order.zonaEntrega?'<div class="zona">'+esc(o.order.zonaEntrega)+'</div>':''}
      </td>
      <td><div style="color:var(--muted);font-size:.8rem">\${esc(o.order.direccion)}</div></td>
      <td><div class="items-list">\${items}</div></td>
      <td>
        <div class="total">$\${fmtARS(o.total)}</div>
        <div class="envio">🛵 A confirmar</div>
      </td>
      <td><span class="pago">\${esc(o.order.pago)}</span></td>
    </tr>\`;
  }).join('');

  document.getElementById('content').innerHTML =
    '<div style="overflow-x:auto"><table>' +
    '<thead><tr><th>Hora</th><th>Cliente</th><th>Dirección</th><th>Productos</th><th>Total</th><th>Pago</th></tr></thead>' +
    '<tbody>'+rows+'</tbody></table></div>';
}

function openModal(id){
  const o = orders.find(x=>x.id===id);
  if(!o) return;
  const items = o.order.items.map(i=>\`
    <div class="modal-item">
      <span>\${i.cantidad>1?i.cantidad+'x ':''}\${esc(i.producto)}</span>
      <span>$\${fmtARS(i.cantidad*i.precioUnit)}</span>
    </div>\`).join('');

  document.getElementById('modal-inner').innerHTML = \`
    <button class="close-btn" onclick="closeModal()">✕</button>
    <h3>Pedido #\${o.id.slice(-5).toUpperCase()}</h3>
    <div class="modal-row"><span class="lbl">🕐 Hora</span><span class="val">\${fmtTime(o.receivedAt)}</span></div>
    <div class="modal-row"><span class="lbl">👤 Cliente</span><span class="val">\${esc(o.order.cliente)}</span></div>
    <div class="modal-row"><span class="lbl">📱 WhatsApp</span><span class="val">\${esc(o.customerPhone)}</span></div>
    \${o.order.zonaEntrega?'<div class="modal-row"><span class="lbl">🗺 Zona</span><span class="val">'+esc(o.order.zonaEntrega)+'</span></div>':''}
    <div class="modal-row"><span class="lbl">📍 Dirección</span><span class="val">\${esc(o.order.direccion)}</span></div>
    <div class="modal-row"><span class="lbl">💳 Pago</span><span class="val">\${esc(o.order.pago)}</span></div>
    <div class="modal-items">
      \${items}
      <div class="modal-total"><span>Subtotal productos</span><span>$\${fmtARS(o.total)}</span></div>
      <div class="modal-item" style="color:var(--muted)"><span>🛵 Envío</span><span>A confirmar</span></div>
    </div>
    \${o.order.notas?'<div class="notas-box">📝 '+esc(o.order.notas)+'</div>':''}
    <a href="https://wa.me/\${o.customerPhone.replace(/[^0-9]/g,'')}" target="_blank"
       style="display:inline-flex;align-items:center;gap:6px;margin-top:1rem;background:#25D366;
              color:#fff;padding:.5rem 1rem;border-radius:7px;text-decoration:none;font-weight:700;font-size:.85rem">
      📲 Contactar por WhatsApp
    </a>\`;
  document.getElementById('modal').classList.add('on');
}

function closeModal(){document.getElementById('modal').classList.remove('on')}

function esc(s){
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`;

export default router;
