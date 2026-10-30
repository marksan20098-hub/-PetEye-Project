const express = require("express"), path = require("path"), fs = require("fs"), crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const E = process.env, app = express();
const sb = createClient(E.SUPABASE_URL, E.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const GUARDAR = (+E.GUARDAR_CADA_MIN || 60) * 6e4, DIAS = +E.BORRAR_DIAS || 7;
const live = new Map(), cache = new Map();   // en vivo (memoria) y mascota+lugares por device_id
app.use(express.json({ limit: "10kb" }));

const dist = (a, b, c, d) => { const r = x => x * Math.PI / 180, h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 12742e3 * Math.asin(Math.sqrt(h)); };
async function petDe(dev) {
  let c = cache.get(dev); if (c && Date.now() - c.t < 3e4) return c;
  const { data: pet } = await sb.from("pets").select("*").eq("device_id", dev).maybeSingle();
  const { data: places } = pet ? await sb.from("places").select("*").eq("pet_id", pet.id) : { data: [] };
  c = { pet, places: places || [], t: Date.now() }; cache.set(dev, c); return c;
}
function estado(pet) {
  const l = live.get(pet.device_id) || { trail: [] };
  return { pet: { id: pet.id, nombre: pet.nombre, estado: pet.estado }, conectado: !!l.seen && Date.now() - l.seen < 3e4,
    rssi: l.rssi, sats: l.sats || 0, pos: l.pos || null, hace: l.pos ? Date.now() - l.pos.t : null, trail: l.trail };
}
async function auth(q, r, n) {
  const { data, error } = await sb.auth.getUser((q.get("authorization") || "").replace("Bearer ", ""));
  if (error || !data.user) return r.status(401).json({ error: "sesión vencida" });
  q.user = data.user; n();
}
async function mia(q, r, n) {
  const { data } = await sb.from("pets").select("*").eq("id", q.params.id).eq("owner_id", q.user.id).maybeSingle();
  if (!data) return r.status(404).json({ error: "mascota no encontrada" });
  q.pet = data; n();
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
  const { pet, places } = await petDe(dev);
  let sonar = false;   // suena si está desaparecida o fuera de todos sus lugares
  if (pet) { sonar = pet.estado === "desaparecida"; if (!sonar && l.pos && places.length) sonar = !places.some(p => dist(l.pos.lat, l.pos.lng, p.lat, p.lng) <= p.radio_m); }
  r.json({ ok: true, sonar });
});

// ---- Dueño (con sesión) ----
app.get("/api/config", (q, r) => r.json({ url: E.SUPABASE_URL, anon: E.SUPABASE_ANON_KEY }));
app.get("/api/pets", auth, async (q, r) => r.json((await sb.from("pets").select("id,nombre,device_id,estado").eq("owner_id", q.user.id)).data || []));
app.post("/api/pets", auth, async (q, r) => {
  const { data, error } = await sb.from("pets").insert({ owner_id: q.user.id, nombre: String(q.body.nombre || "Mascota").slice(0, 40), device_id: q.body.device_id || "esp32-01" }).select().single();
  cache.clear(); error ? r.status(400).json({ error: error.message }) : r.json(data);
});
app.get("/api/pets/:id/live", auth, mia, (q, r) => r.json(estado(q.pet)));
app.get("/api/pets/:id/history", auth, mia, async (q, r) => r.json((await sb.from("positions").select("lat,lng,created_at").eq("pet_id", q.pet.id).order("created_at").limit(1000)).data || []));
app.get("/api/pets/:id/places", auth, mia, async (q, r) => r.json((await sb.from("places").select("*").eq("pet_id", q.pet.id)).data || []));
app.post("/api/pets/:id/places", auth, mia, async (q, r) => {
  const { nombre, lat, lng, radio_m } = q.body;
  const { error } = await sb.from("places").insert({ pet_id: q.pet.id, nombre: String(nombre || "Lugar").slice(0, 40), lat, lng, radio_m: radio_m || 20 });
  cache.clear(); r.json({ ok: !error, error: error && error.message });
});
app.delete("/api/pets/:id/places/:pid", auth, mia, async (q, r) => { await sb.from("places").delete().eq("id", q.params.pid).eq("pet_id", q.pet.id); cache.clear(); r.json({ ok: true }); });
app.post("/api/pets/:id/desaparecida", auth, mia, async (q, r) => {
  const d = q.pet.estado !== "desaparecida";
  await sb.from("pets").update({ estado: d ? "desaparecida" : "normal", desaparecida_desde: d ? new Date() : null }).eq("id", q.pet.id);
  cache.clear(); r.json({ estado: d ? "desaparecida" : "normal" });
});
app.post("/api/pets/:id/share", auth, mia, async (q, r) => {
  const h = [1, 24, 168].includes(+q.body.horas) ? +q.body.horas : 24, token = crypto.randomBytes(16).toString("hex");
  await sb.from("share_links").insert({ pet_id: q.pet.id, token, expires_at: new Date(Date.now() + h * 36e5), created_by: q.user.id });
  r.json({ token });
});
app.delete("/api/pets/:id/share", auth, mia, async (q, r) => { await sb.from("share_links").update({ revoked: true }).eq("pet_id", q.pet.id); r.json({ ok: true }); });

// ---- Enlace de solo lectura (sin cuenta) ----
app.get("/api/ver/:token", async (q, r) => {
  const { data: l } = await sb.from("share_links").select("*,pets(*)").eq("token", q.params.token).maybeSingle();
  if (!l || l.revoked || new Date(l.expires_at) < new Date()) return r.status(410).json({ error: "Enlace vencido o cancelado" });
  r.json(estado(l.pets));
});

// ---- Páginas y documento ----
const pagina = ["public/index.html", "index.html"].map(p => path.join(__dirname, p)).find(fs.existsSync);
app.get(["/", "/ver/:t"], (q, r) => r.sendFile(pagina));
const informe = path.join(__dirname, "documento", "Modulo_rastreador_GPS_para_mascotas.pdf");
app.get("/descargar/informe", (q, r) => fs.existsSync(informe) ? r.download(informe) : r.status(404).send("No disponible"));

// ---- Historial cada GUARDAR ms y borrado de lo viejo ----
setInterval(async () => {
  for (const [dev, l] of live) {
    if (!l.pos || Date.now() - l.pos.t > 6e5 || Date.now() - l.saved < GUARDAR) continue;
    const { pet } = await petDe(dev); if (!pet) continue;
    await sb.from("positions").insert({ pet_id: pet.id, lat: l.pos.lat, lng: l.pos.lng, speed: l.pos.speed, sats: l.pos.sats, hdop: l.pos.hdop });
    l.saved = Date.now();
  }
}, 6e4);
setInterval(async () => { await sb.from("positions").delete().lt("created_at", new Date(Date.now() - DIAS * 864e5).toISOString()); }, 36e5);

app.listen(process.env.PORT || 3000, () => console.log("Servidor listo"));
