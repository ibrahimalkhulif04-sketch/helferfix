require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3')(session);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'helferfix.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','customer','driver')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ride_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES users(id),
 service_type TEXT NOT NULL DEFAULT 'airport',
 pickup TEXT NOT NULL,
 destination TEXT NOT NULL,
 travel_date TEXT,
 travel_time TEXT,
 passengers INTEGER NOT NULL DEFAULT 2,
 luggage INTEGER NOT NULL DEFAULT 2,
 vehicle_type TEXT NOT NULL DEFAULT 'PKW',
 notes TEXT,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','quoted','accepted','cancelled','completed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS quotes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ride_request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 driver_id INTEGER NOT NULL REFERENCES users(id),
 price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
 message TEXT,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(ride_request_id, driver_id)
);
CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

// The first admin is created only from environment variables. Public signup cannot create admins.
async function ensureAdmin() {
 const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
 const password = process.env.ADMIN_PASSWORD || '';
 if (!email || !password) {
   console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not configured. Admin bootstrap skipped. Copy .env.example to .env and configure them.');
   return;
 }
 const existing = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
 if (!existing) {
   const hash = await bcrypt.hash(password, 12);
   db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')")
     .run('HelferFix Admin', email, hash);
   console.log(`Initial admin created for ${email}. Change the password after first login.`);
 }
}

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false })); // Inline frontend scripts; enable a CSP before public production deployment.
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
if (isProduction) app.set('trust proxy', 1);
app.use(session({
 secret: process.env.SESSION_SECRET || 'development-only-secret-change-me-now-please',
 resave: false,
 saveUninitialized: false,
 store: new SQLiteStoreFactory({ db: 'sessions.sqlite', dir: dataDir }),
 cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === '1', maxAge: 1000 * 60 * 60 * 12 }
}));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const emailOk = s => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const clean = (v, max=180) => typeof v === 'string' ? v.trim().slice(0,max) : '';
function currentUser(req) {
 if (!req.session.userId) return null;
 return db.prepare('SELECT id,name,email,role,created_at,active FROM users WHERE id=?').get(req.session.userId) || null;
}
function requireAuth(req,res,next) {
 const user = currentUser(req);
 if (!user || !user.active) return res.status(401).json({ error: 'Bitte melde dich an.' });
 req.user = user; next();
}
function requireRole(...roles) {
 return (req,res,next) => {
   const user = currentUser(req);
   if (!user || !user.active) return res.status(401).json({ error: 'Bitte melde dich an.' });
   if (!roles.includes(user.role)) return res.status(403).json({ error: 'Keine Berechtigung.' });
   req.user = user; next();
 };
}

app.get('/api/health', (req,res) => res.json({ ok:true, app:'HelferFix', mode:'MVP', bookingsAreConfirmed:false }));
app.get('/api/me', (req,res) => res.json({ user: currentUser(req) }));
app.post('/api/auth/register', async (req,res) => {
 const name = clean(req.body.name, 100);
 const email = clean(req.body.email, 254).toLowerCase();
 const password = typeof req.body.password === 'string' ? req.body.password : '';
 const role = req.body.role;
 if (name.length < 2 || !emailOk(email) || password.length < 10 || password.length > 200 || !['customer','driver'].includes(role)) {
   return res.status(400).json({ error: 'Bitte Name, gültige E-Mail, Passwort (mind. 10 Zeichen) und Rolle korrekt angeben.' });
 }
 try {
   const hash = await bcrypt.hash(password, 12);
   const result = db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name,email,hash,role);
   req.session.regenerate(err => {
     if (err) return res.status(500).json({ error:'Sitzung konnte nicht erstellt werden.' });
     req.session.userId = Number(result.lastInsertRowid);
     res.status(201).json({ user: currentUser(req), message:'Konto erstellt. Bitte beachte: Die Angaben eines Fahrers sind noch nicht geprüft.' });
   });
 } catch (e) {
   if (String(e.code).includes('SQLITE_CONSTRAINT_UNIQUE')) return res.status(409).json({ error:'Diese E-Mail-Adresse ist bereits registriert.' });
   console.error(e); res.status(500).json({ error:'Registrierung fehlgeschlagen.' });
 }
});
app.post('/api/auth/login', async (req,res) => {
 const email = clean(req.body.email,254).toLowerCase();
 const password = typeof req.body.password === 'string' ? req.body.password : '';
 const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if (!user || !user.active || !(await bcrypt.compare(password,user.password_hash))) return res.status(401).json({ error:'E-Mail oder Passwort ist falsch.' });
 req.session.regenerate(err => {
   if (err) return res.status(500).json({ error:'Anmeldung fehlgeschlagen.' });
   req.session.userId = user.id;
   res.json({ user: currentUser(req), message:'Erfolgreich angemeldet.' });
 });
});
app.post('/api/auth/logout', (req,res) => req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok:true }); }));

// Customer creates a trip request. This is a request, never an automatic confirmed booking.
app.post('/api/rides', requireRole('customer'), (req,res) => {
 const pickup = clean(req.body.pickup,180), destination = clean(req.body.destination,180);
 const serviceType = ['airport','city','hourly','garden','moving'].includes(req.body.serviceType) ? req.body.serviceType : 'airport';
 const travelDate = clean(req.body.travelDate,10), travelTime = clean(req.body.travelTime,5);
 const passengers = Number(req.body.passengers), luggage = Number(req.body.luggage);
 const vehicleType = ['PKW','Van','egal'].includes(req.body.vehicleType) ? req.body.vehicleType : 'PKW';
 const notes = clean(req.body.notes,1000);
 if (!pickup || !destination || pickup.length < 2 || destination.length < 2 || !Number.isInteger(passengers) || passengers < 1 || passengers > 8 || !Number.isInteger(luggage) || luggage < 0 || luggage > 20) return res.status(400).json({error:'Bitte prüfe Start, Ziel, Personen und Gepäck.'});
 if (travelDate && !/^\d{4}-\d{2}-\d{2}$/.test(travelDate)) return res.status(400).json({error:'Ungültiges Datum.'});
 if (travelTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(travelTime)) return res.status(400).json({error:'Ungültige Uhrzeit.'});
 const result = db.prepare(`INSERT INTO ride_requests (customer_id,service_type,pickup,destination,travel_date,travel_time,passengers,luggage,vehicle_type,notes) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(req.user.id,serviceType,pickup,destination,travelDate||null,travelTime||null,passengers,luggage,vehicleType,notes||null);
 res.status(201).json({ id:Number(result.lastInsertRowid), status:'new', message:'Anfrage gespeichert. Es ist noch keine Fahrt gebucht oder bestätigt.' });
});
app.get('/api/rides/mine', requireRole('customer'), (req,res) => {
 const rides = db.prepare('SELECT r.*, (SELECT COUNT(*) FROM quotes q WHERE q.ride_request_id=r.id) AS quote_count FROM ride_requests r WHERE customer_id=? ORDER BY r.id DESC').all(req.user.id);
 res.json({ rides });
});
app.get('/api/rides/open', requireRole('driver'), (req,res) => {
 const rides = db.prepare("SELECT r.id,r.service_type,r.pickup,r.destination,r.travel_date,r.travel_time,r.passengers,r.luggage,r.vehicle_type,r.notes,r.created_at FROM ride_requests r WHERE r.status IN ('new','quoted') AND NOT EXISTS (SELECT 1 FROM quotes q WHERE q.ride_request_id=r.id AND q.driver_id=?) ORDER BY r.id DESC").all(req.user.id);
 res.json({ rides });
});
app.post('/api/rides/:id/quotes', requireRole('driver'), (req,res) => {
 const id = Number(req.params.id), price = Number(req.body.priceEuro), message = clean(req.body.message,500);
 if (!Number.isInteger(id) || !Number.isFinite(price) || price < 0 || price > 10000) return res.status(400).json({error:'Bitte gib einen gültigen Preis an.'});
 const ride = db.prepare("SELECT id,status FROM ride_requests WHERE id=? AND status IN ('new','quoted')").get(id);
 if (!ride) return res.status(404).json({error:'Diese Anfrage ist nicht mehr offen.'});
 try {
   db.prepare('INSERT INTO quotes (ride_request_id,driver_id,price_cents,message) VALUES (?,?,?,?)').run(id,req.user.id,Math.round(price*100),message||null);
   db.prepare("UPDATE ride_requests SET status='quoted' WHERE id=? AND status='new'").run(id);
   res.status(201).json({message:'Preisangebot gespeichert. Es wurde noch keine Fahrt bestätigt.'});
 } catch(e) { if (String(e.code).includes('SQLITE_CONSTRAINT_UNIQUE')) return res.status(409).json({error:'Du hast bereits ein Angebot für diese Anfrage abgegeben.'}); console.error(e); res.status(500).json({error:'Angebot konnte nicht gespeichert werden.'}); }
});
app.get('/api/rides/:id/quotes', requireRole('customer','admin'), (req,res) => {
 const id = Number(req.params.id);
 const ride = db.prepare('SELECT * FROM ride_requests WHERE id=?').get(id);
 if (!ride) return res.status(404).json({error:'Anfrage nicht gefunden.'});
 if (req.user.role !== 'admin' && ride.customer_id !== req.user.id) return res.status(403).json({error:'Keine Berechtigung.'});
 const quotes = db.prepare('SELECT q.id,q.price_cents,q.message,q.status,q.created_at,u.name AS driver_name FROM quotes q JOIN users u ON u.id=q.driver_id WHERE q.ride_request_id=? ORDER BY q.price_cents ASC').all(id);
 res.json({quotes:quotes.map(q=>({...q,priceEuro:(q.price_cents/100).toFixed(2)}))});
});
app.post('/api/quotes/:id/accept', requireRole('customer'), (req,res) => {
 const quote = db.prepare('SELECT q.*,r.customer_id,r.id AS ride_id,r.status AS ride_status FROM quotes q JOIN ride_requests r ON r.id=q.ride_request_id WHERE q.id=?').get(Number(req.params.id));
 if (!quote || quote.customer_id !== req.user.id) return res.status(404).json({error:'Angebot nicht gefunden.'});
 if (!['new','quoted'].includes(quote.ride_status)) return res.status(409).json({error:'Die Anfrage wurde bereits bearbeitet.'});
 const accept = db.transaction(() => {
   db.prepare("UPDATE quotes SET status=CASE WHEN id=? THEN 'accepted' ELSE 'declined' END WHERE ride_request_id=?").run(quote.id,quote.ride_id);
   db.prepare("UPDATE ride_requests SET status='accepted' WHERE id=?").run(quote.ride_id);
 });
 accept();
 res.json({message:'Angebot angenommen. Dies ist eine vorläufige Bestätigung innerhalb des Prototyps; Fahrtdurchführung, Identität und Genehmigungen müssen separat geklärt werden.'});
});

// Admin-only management API. Registration never grants admin rights.
app.get('/api/admin/summary', requireRole('admin'), (req,res) => {
 res.json({ users:db.prepare('SELECT COUNT(*) n FROM users').get().n, drivers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='driver'").get().n, customers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n, rides:db.prepare('SELECT COUNT(*) n FROM ride_requests').get().n, newRides:db.prepare("SELECT COUNT(*) n FROM ride_requests WHERE status='new'").get().n });
});
app.get('/api/admin/users', requireRole('admin'), (req,res) => res.json({users:db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY id DESC LIMIT 500').all()}));
app.patch('/api/admin/users/:id', requireRole('admin'), (req,res) => {
 const id=Number(req.params.id), active=req.body.active;
 if (!Number.isInteger(id) || typeof active !== 'boolean') return res.status(400).json({error:'Ungültige Daten.'});
 const target=db.prepare('SELECT id,role FROM users WHERE id=?').get(id);
 if (!target) return res.status(404).json({error:'Nutzer nicht gefunden.'});
 if (target.role==='admin') return res.status(400).json({error:'Admin-Konten können hier nicht deaktiviert werden.'});
 db.prepare('UPDATE users SET active=? WHERE id=?').run(active?1:0,id);
 res.json({message:active?'Nutzer aktiviert.':'Nutzer deaktiviert.'});
});
app.get('/api/admin/rides', requireRole('admin'), (req,res) => res.json({rides:db.prepare('SELECT r.*,u.name AS customer_name,u.email AS customer_email FROM ride_requests r JOIN users u ON u.id=r.customer_id ORDER BY r.id DESC LIMIT 500').all()}));
app.patch('/api/admin/rides/:id', requireRole('admin'), (req,res) => {
 const id=Number(req.params.id), status=req.body.status;
 if (!Number.isInteger(id) || !['new','quoted','accepted','cancelled','completed'].includes(status)) return res.status(400).json({error:'Ungültiger Status.'});
 const result=db.prepare('UPDATE ride_requests SET status=? WHERE id=?').run(status,id);
 if (!result.changes) return res.status(404).json({error:'Anfrage nicht gefunden.'});
 res.json({message:'Status aktualisiert.'});
});
app.get('/api/admin/settings', requireRole('admin'), (req,res) => {
 const rows=db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all();
 const values=Object.fromEntries(rows.map(r=>[r.key,r.value]));
 res.json({settings:{site_name:values.site_name||'HelferFix', platform_fee_percent:values.platform_fee_percent||'10', support_email:values.support_email||''}});
});
app.put('/api/admin/settings', requireRole('admin'), (req,res) => {
 const siteName=clean(req.body.site_name,80), supportEmail=clean(req.body.support_email,254), fee=Number(req.body.platform_fee_percent);
 if (!siteName || !Number.isFinite(fee) || fee<0 || fee>30 || (supportEmail && !emailOk(supportEmail))) return res.status(400).json({error:'Bitte prüfe Name, E-Mail und Gebühr (0–30 %).'});
 const save=db.transaction(() => {
   for (const [key,value] of Object.entries({site_name:siteName,platform_fee_percent:String(fee),support_email:supportEmail})) db.prepare("INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP").run(key,value);
 });
 save(); res.json({message:'Einstellungen gespeichert.'});
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:'Interner Fehler.'}); });
ensureAdmin().then(() => app.listen(PORT, () => console.log(`HelferFix läuft unter http://localhost:${PORT}`))).catch(err => { console.error(err); process.exit(1); });
