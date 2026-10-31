const express = require("express"), path = require("path"), fs = require("fs"), crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const E = process.env, app = express();
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const GUARDAR = (+E.GUARDAR_CADA_MIN || 30) * 6e4, DIAS = +E.BORRAR_DIAS || 7;
const live = new Map(), cache = new Map();   // en vivo (memoria) y mascota+lugares por device_id
app.use(express.json({ limit: "10kb" }));

const dist = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742e3 * Math.asin(Math.sqrt(h)); };
const wk = crypto.createHash("sha256").update(String(E.WIFI_KEY || E.API_KEY)).digest();   // las claves de WiFi se guardan cifradas
const cifrar = t => { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", wk, iv), d = Buffer.concat([c.update(t, "utf8"), c.final()]); return [iv, c.getAuthTag(), d].map(b => b.toString("base64")).join("."); };
const descifrar = t => { const [iv, tag, d] = t.split(".").map(x => Buffer.from(x, "base64")), c = crypto.createDecipheriv("aes-256-gcm", wk, iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString("utf8"); };
const hex = t => Buffer.from(t, "utf8").toString("hex");
async function petDe(dev) {
  let c = cache.get(dev); if (c && Date.now() - c.t < 3e4) return c;
  const { data: pet } = await sb.from("pets").select("*").eq("device_id", dev).maybeSingle();
  const { data: places } = pet ? await sb.from("places").select("*").eq("pet_id", pet.id) : { data: [] };
  const { data: wf } = pet ? await sb.from("wifi_networks").select("ssid,pass_enc").eq("pet_id", pet.id).order("created_at") : { data: [] };
  const wifi = (wf || []).map(w => { try { return hex(w.ssid) + ":" + hex(descifrar(w.pass_enc)); } catch (e) { return null; } }).filter(Boolean).join(";");
  c = { pet, places: places || [], wifi, wv: wifi ? crypto.createHash("sha1").update(wifi).digest("hex").slice(0, 8) : "0", t: Date.now() };
  cache.set(dev, c); return c;
}
function estado(pet) {
  const l = live.get(pet.device_id) || { trail: [] };
  return { pet: { id: pet.id, nombre: pet.nombre, estado: pet.estado }, conectado: !!l.seen && Date.now() - l.seen < 3e4,
    rssi: l.rssi, sats: l.sats || 0, pos: l.pos || null, hace: l.pos ? Date.now() - l.pos.t : null, trail: l.trail };
}
async function auth(q, r, n) {
  const { data, error } = await sb.auth.getUser((q.get("authorization") || "").replace("Bearer ", ""));
  if (error || !data.user) { console.log("auth falló:", error && error.message); return r.status(401).json({ error: "sesión vencida" }); }
  q.user = data.user; n();
}
async function mia(q, r, n) {   // dueño, administrador u observador de la mascota
  const { data: pet } = await sb.from("pets").select("*").eq("id", q.params.id).maybeSingle();
  if (!pet) return r.status(404).json({ error: "mascota no encontrada" });
  if (pet.owner_id === q.user.id) q.rol = "dueño";
  else {
    const { data: m } = await sb.from("pet_members").select("role").eq("pet_id", pet.id).eq("user_id", q.user.id).maybeSingle();
    if (!m) return r.status(404).json({ error: "mascota no encontrada" });
    q.rol = m.role === "admin" ? "admin" : "observador";
  }
  q.pet = pet; n();
}
const dueno = (q, r, n) => q.rol === "dueño" ? n() : r.status(403).json({ error: "Solo el dueño puede hacer esto" });
const edita = (q, r, n) => q.rol !== "observador" ? n() : r.status(403).json({ error: "Tu rol es de solo lectura" });
async function calle(lat, lng) {   // nombre de la calle (OpenStreetMap); se consulta solo al guardar un punto
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&accept-language=es&lat=${lat}&lon=${lng}`, { headers: { "User-Agent": "PetEye-Project/1.0 (proyecto educativo)" }, signal: AbortSignal.timeout(6000) });
    const a = (await r.json()).address || {};
    const via = [a.road || a.pedestrian || a.path, a.house_number].filter(Boolean).join(" ");
    return [via, a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(", ").slice(0, 160) || null;
  } catch (e) { return null; } finally { await new Promise(r => setTimeout(r, 1100)); }
}

// ---- ESP32 ----
app.post("/api/update", async (q, r) => {
  if (q.get("x-api-key") !== E.API_KEY) return r.status(401).json({ error: "clave" });
  const b = q.body || {}, dev = b.device_id || "esp32-01", now = Date.now();
  const l = live.get(dev) || { trail: [], saved: 0 };
  l.seen = now; l.rssi = b.rssi; l.sats = +b.sats || 0;
  if (b.fix && typeof b.lat === "number" && typeof b.lng === "number") {
    l.pos = { lat: b.lat, lng: b.lng, speed: +b.speed || 0, alt: +b.alt || 0, sats: +b.sats || 0, hdop: +b.hdop || 0, t: now };
    const u = l.trail[l.trail.length - 1];
    if (!u || dist(u[0], u[1], b.lat, b.lng) > 3) { l.trail.push([b.lat, b.lng]); if (l.trail.length > 720) l.trail.shift(); }
  }
  live.set(dev, l);
  const { pet, places, wifi, wv } = await petDe(dev);
  if (b.net) l.net = Buffer.from(String(b.net), "hex").toString("utf8");   // red a la que está conectada la placa
  l.wv = b.wv;
  let sonar = false;   // suena si está desaparecida o fuera de todos sus lugares
  if (pet) { sonar = pet.estado === "desaparecida"; if (!sonar && l.pos && places.some(p => p.tipo === "casa")) sonar = !places.some(p => dist(l.pos.lat, l.pos.lng, p.lat, p.lng) <= p.radio_m); }
  const casa = places.find(p => p.tipo === "casa");   // la placa usa estos datos como respaldo sin internet
  r.json({ ok: true, sonar, casa: casa ? { lat: casa.lat, lng: casa.lng, radio: casa.radio_m } : null, wv, ...(b.wv !== wv ? { wifi } : {}) });   // la lista de WiFi solo viaja si cambió
});

// ---- Dueño (con sesión) ----
app.get("/api/config", (q, r) => r.json({ url: E.SUPABASE_URL, anon: E.SUPABASE_ANON_KEY }));
app.get("/api/pets", auth, async (q, r) => {
  const { data: mias } = await sb.from("pets").select("id,nombre,device_id,estado").eq("owner_id", q.user.id);
  const { data: comp } = await sb.from("pet_members").select("role,pets(id,nombre,device_id,estado)").eq("user_id", q.user.id);
  r.json([...(mias || []).map(p => ({ ...p, rol: "dueño" })), ...(comp || []).filter(c => c.pets).map(c => ({ ...c.pets, rol: c.role === "admin" ? "admin" : "observador" }))]);
});
app.post("/api/pets", auth, async (q, r) => {
  const dev = String(q.body.device_id || "").trim() || null;
  const { data, error } = await sb.from("pets").insert({ owner_id: q.user.id, nombre: String(q.body.nombre || "Mascota").slice(0, 40), device_id: dev }).select().single();
  cache.clear();
  if (error) return r.status(400).json({ error: error.code === "23505" ? "Ese ID de dispositivo ya está asignado a otra mascota" : error.message });
  r.json(data);
});
app.get("/api/pets/:id/live", auth, mia, (q, r) => r.json({ ...estado(q.pet), rol: q.rol }));
app.get("/api/pets/:id/history", auth, mia, async (q, r) => r.json((await sb.from("positions").select("lat,lng,created_at,direccion").eq("pet_id", q.pet.id).order("created_at", { ascending: false }).limit(500)).data || []));
app.get("/api/pets/:id/places", auth, mia, async (q, r) => r.json((await sb.from("places").select("*").eq("pet_id", q.pet.id)).data || []));
const clamp = v => Math.min(5000, Math.max(5, Math.round(+v || 20)));
app.post("/api/pets/:id/places", auth, mia, edita, async (q, r) => {
  const b = q.body, tipo = b.tipo === "casa" ? "casa" : "habitual";
  if (!(b.lat >= -90 && b.lat <= 90 && b.lng >= -180 && b.lng <= 180)) return r.status(400).json({ error: "Posición inválida" });
  if (tipo === "casa") await sb.from("places").update({ tipo: "habitual" }).eq("pet_id", q.pet.id).eq("tipo", "casa");   // una sola casa
  const { error } = await sb.from("places").insert({ pet_id: q.pet.id, nombre: String(b.nombre || "Lugar").slice(0, 40), lat: b.lat, lng: b.lng, radio_m: clamp(b.radio_m), tipo });
  cache.clear(); error ? r.status(400).json({ error: error.message }) : r.json({ ok: true });
});
app.put("/api/pets/:id/places/:pid", auth, mia, edita, async (q, r) => {
  const b = q.body, up = { nombre: String(b.nombre || "Lugar").slice(0, 40), radio_m: clamp(b.radio_m), tipo: b.tipo === "casa" ? "casa" : "habitual" };
  if (typeof b.lat === "number" && typeof b.lng === "number") { up.lat = b.lat; up.lng = b.lng; }
  if (up.tipo === "casa") await sb.from("places").update({ tipo: "habitual" }).eq("pet_id", q.pet.id).eq("tipo", "casa").neq("id", q.params.pid);
  const { error } = await sb.from("places").update(up).eq("id", q.params.pid).eq("pet_id", q.pet.id);
  cache.clear(); error ? r.status(400).json({ error: error.message }) : r.json({ ok: true });
});
app.delete("/api/pets/:id/places/:pid", auth, mia, edita, async (q, r) => { await sb.from("places").delete().eq("id", q.params.pid).eq("pet_id", q.pet.id); cache.clear(); r.json({ ok: true }); });
app.post("/api/pets/:id/desaparecida", auth, mia, edita, async (q, r) => {
  const d = q.pet.estado !== "desaparecida";
  await sb.from("pets").update({ estado: d ? "desaparecida" : "normal", desaparecida_desde: d ? new Date() : null }).eq("id", q.pet.id);
  cache.clear(); r.json({ estado: d ? "desaparecida" : "normal" });
});
app.get("/api/pets/:id/share", auth, mia, dueno, async (q, r) => r.json((await sb.from("share_links").select("id,etiqueta,token,expires_at").eq("pet_id", q.pet.id).eq("revoked", false).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false })).data || []));
app.post("/api/pets/:id/share", auth, mia, dueno, async (q, r) => {
  const h = [1, 24, 168].includes(+q.body.horas) ? +q.body.horas : 24, token = crypto.randomBytes(16).toString("hex");
  const { error } = await sb.from("share_links").insert({ pet_id: q.pet.id, token, etiqueta: String(q.body.etiqueta || "").slice(0, 40), expires_at: new Date(Date.now() + h * 36e5), created_by: q.user.id });
  error ? r.status(400).json({ error: error.message }) : r.json({ token });
});
app.delete("/api/pets/:id/share/:sid", auth, mia, dueno, async (q, r) => { await sb.from("share_links").update({ revoked: true }).eq("id", q.params.sid).eq("pet_id", q.pet.id); r.json({ ok: true }); });
app.delete("/api/pets/:id/share", auth, mia, dueno, async (q, r) => { await sb.from("share_links").update({ revoked: true }).eq("pet_id", q.pet.id); r.json({ ok: true }); });

// ---- Personas con acceso (solo el dueño las administra) ----
const mailDe = async id => { const { data } = await sb.auth.admin.getUserById(id); return data && data.user ? data.user.email : "?"; };
app.get("/api/pets/:id/members", auth, mia, dueno, async (q, r) => {
  const { data } = await sb.from("pet_members").select("user_id,role").eq("pet_id", q.pet.id);
  r.json(await Promise.all((data || []).map(async m => ({ user_id: m.user_id, role: m.role, email: await mailDe(m.user_id) }))));
});
app.post("/api/pets/:id/members", auth, mia, dueno, async (q, r) => {
  const email = String(q.body.email || "").trim().toLowerCase(), role = q.body.role === "admin" ? "admin" : "viewer";
  const { data } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const u = ((data && data.users) || []).find(x => (x.email || "").toLowerCase() === email);
  if (!u) return r.status(404).json({ error: "Esa persona todavía no tiene cuenta. Pedile que se registre con ese correo y volvé a intentar." });
  if (u.id === q.pet.owner_id) return r.status(400).json({ error: "Esa cuenta ya es la dueña de la mascota" });
  const { error } = await sb.from("pet_members").upsert({ pet_id: q.pet.id, user_id: u.id, role });
  error ? r.status(400).json({ error: error.message }) : r.json({ ok: true });
});
app.put("/api/pets/:id/members/:uid", auth, mia, dueno, async (q, r) => { await sb.from("pet_members").update({ role: q.body.role === "admin" ? "admin" : "viewer" }).eq("pet_id", q.pet.id).eq("user_id", q.params.uid); r.json({ ok: true }); });
app.delete("/api/pets/:id/members/:uid", auth, mia, dueno, async (q, r) => { await sb.from("pet_members").delete().eq("pet_id", q.pet.id).eq("user_id", q.params.uid); r.json({ ok: true }); });

// ---- Redes WiFi de la placa (se administran desde la página) ----
app.get("/api/pets/:id/wifi", auth, mia, dueno, async (q, r) => {
  const { data } = await sb.from("wifi_networks").select("id,ssid").eq("pet_id", q.pet.id).order("created_at");
  const l = live.get(q.pet.device_id) || {}, c = q.pet.device_id ? await petDe(q.pet.device_id) : {};
  r.json({ redes: data || [], actual: l.net || null, aplicada: !!l.seen && l.wv === c.wv });
});
app.post("/api/pets/:id/wifi", auth, mia, dueno, async (q, r) => {
  const ssid = String(q.body.ssid || "").trim(), pass = String(q.body.pass || "");
  if (!ssid || ssid.length > 32) return r.status(400).json({ error: "El nombre de la red debe tener de 1 a 32 caracteres" });
  if (pass && (pass.length < 8 || pass.length > 63)) return r.status(400).json({ error: "La contraseña debe tener de 8 a 63 caracteres (o dejala vacía si la red es abierta)" });
  const { count } = await sb.from("wifi_networks").select("id", { count: "exact", head: true }).eq("pet_id", q.pet.id);
  if (count >= 10) return r.status(400).json({ error: "Máximo 10 redes por placa" });
  const { error } = await sb.from("wifi_networks").upsert({ pet_id: q.pet.id, ssid, pass_enc: cifrar(pass) }, { onConflict: "pet_id,ssid" });
  cache.clear(); error ? r.status(400).json({ error: error.message }) : r.json({ ok: true });
});
app.delete("/api/pets/:id/wifi/:wid", auth, mia, dueno, async (q, r) => { await sb.from("wifi_networks").delete().eq("id", q.params.wid).eq("pet_id", q.pet.id); cache.clear(); r.json({ ok: true }); });

// ---- Enlace de solo lectura (sin cuenta) ----
app.get("/api/ver/:token", async (q, r) => {
  const { data: l } = await sb.from("share_links").select("*,pets(*)").eq("token", q.params.token).maybeSingle();
  if (!l || l.revoked || new Date(l.expires_at) < new Date()) return r.status(410).json({ error: "Enlace vencido o cancelado" });
  r.json(estado(l.pets));
});

// ---- Panel de desarrollador (oculto, protegido con DEV_KEY) ----
const hash = s => crypto.createHash("sha256").update(String(s)).digest();
function dev(q, r, n) {
  if (!E.DEV_KEY || !crypto.timingSafeEqual(hash(q.get("x-dev-key") || ""), hash(E.DEV_KEY))) return r.status(404).json({});
  n();
}
const demos = new Map();
app.get("/api/dev/estado", dev, async (q, r) => {
  const { data: pets } = await sb.from("pets").select("id,nombre,device_id,estado,owner_id,created_at");
  const { data: us } = await sb.auth.admin.listUsers({ perPage: 200 });
  const mail = Object.fromEntries(((us && us.users) || []).map(u => [u.id, u.email]));
  const now = Date.now(), f = d => { const l = live.get(d); return l ? { hace: l.seen ? Math.round((now - l.seen) / 1000) : 9999, rssi: l.rssi, sats: l.sats || 0, puntos: l.trail.length, demo: !!l.demo } : null; };
  const reg = new Set((pets || []).map(p => p.device_id));
  r.json({ pets: (pets || []).map(p => ({ ...p, dueno: mail[p.owner_id] || "?", live: f(p.device_id) })),
    sinMascota: [...live.keys()].filter(d => !reg.has(d)).map(d => ({ device_id: d, live: f(d) })) });
});
app.post("/api/dev/demo", dev, (q, r) => {   // demo solo para el desarrollador
  const d = q.body.device_id; clearInterval(demos.get(d)); demos.delete(d);
  if (q.body.on) {
    const l = live.get(d) || { trail: [], saved: 0 }; live.set(d, l); l.demo = true;
    const c = l.pos ? [l.pos.lat, l.pos.lng] : [-25.283, -57.632]; let a = 0;
    demos.set(d, setInterval(() => {
      a += 0.12; const la = c[0] + 0.0015 * Math.sin(a), lo = c[1] + 0.002 * Math.cos(a), t = Date.now();
      l.seen = t; l.rssi = -55; l.sats = 9; l.pos = { lat: la, lng: lo, speed: 4 + 2 * Math.sin(a * 3), alt: 80, sats: 9, hdop: 1, t };
      l.trail.push([la, lo]); if (l.trail.length > 720) l.trail.shift();
    }, 3000));
  } else { const l = live.get(d); if (l) { l.demo = false; l.trail = []; l.pos = null; l.seen = 0; } }
  r.json({ ok: true });
});
app.delete("/api/dev/pets/:id/positions", dev, async (q, r) => { await sb.from("positions").delete().eq("pet_id", q.params.id); r.json({ ok: true }); });
app.delete("/api/dev/pets/:id", dev, async (q, r) => { await sb.from("pets").delete().eq("id", q.params.id); cache.clear(); r.json({ ok: true }); });
app.get("/dev", (q, r) => r.sendFile(path.join(__dirname, "dev.html")));

// ---- Páginas y documento ----
const pagina = ["public/index.html", "index.html"].map(p => path.join(__dirname, p)).find(fs.existsSync);
app.get(["/", "/ver/:t"], (q, r) => r.sendFile(pagina));
const informe = path.join(__dirname, "documento", "Modulo_rastreador_GPS_para_mascotas.pdf");
app.get("/descargar/informe", (q, r) => fs.existsSync(informe) ? r.download(informe) : r.status(404).send("No disponible"));

// ---- Historial cada GUARDAR ms y borrado de lo viejo ----
setInterval(async () => {
  for (const [dev, l] of live) {
    if (l.demo || !l.pos || Date.now() - l.pos.t > 6e5 || Date.now() - l.saved < GUARDAR) continue;
    const { pet } = await petDe(dev); if (!pet) continue;
    const fila = { pet_id: pet.id, lat: l.pos.lat, lng: l.pos.lng, speed: l.pos.speed, sats: l.pos.sats, hdop: l.pos.hdop };
    const { error } = await sb.from("positions").insert({ ...fila, direccion: await calle(l.pos.lat, l.pos.lng) });
    if (error) await sb.from("positions").insert(fila);   // por si todavía falta la columna "direccion"
    l.saved = Date.now();
  }
}, 6e4);
setInterval(async () => { await sb.from("positions").delete().lt("created_at", new Date(Date.now() - DIAS * 864e5).toISOString()); }, 36e5);

app.listen(process.env.PORT || 3000, () => console.log("Servidor listo"));
