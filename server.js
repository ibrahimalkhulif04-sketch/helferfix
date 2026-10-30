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
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','customer','driver')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ride_requests (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES users(id),
 service_type TEXT NOT NULL DEFAULT 'airport', pickup TEXT NOT NULL,
 destination TEXT NOT NULL, travel_date TEXT, travel_time TEXT,
 passengers INTEGER NOT NULL DEFAULT 2, luggage INTEGER NOT NULL DEFAULT 2,
 vehicle_type TEXT NOT NULL DEFAULT 'PKW', notes TEXT,
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','quoted','accepted','cancelled','completed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS quotes (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ride_request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 driver_id INTEGER NOT NULL REFERENCES users(id), price_cents INTEGER NOT NULL CHECK(price_cents >= 0),
 message TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(ride_request_id, driver_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS chat_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ride_request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 sender_id INTEGER NOT NULL REFERENCES users(id),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_ride_id ON chat_messages(ride_request_id, id);
CREATE TABLE IF NOT EXISTS chat_notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, ride_request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, read_at TEXT);
CREATE INDEX IF NOT EXISTS idx_chat_notifications_recipient ON chat_notifications(recipient_id, read_at, id);
`);

// Add delivery/read timestamps without deleting existing chat history.
const messageColumns = new Set(db.prepare('PRAGMA table_info(chat_messages)').all().map(c => c.name));
if (!messageColumns.has('delivered_at')) db.exec('ALTER TABLE chat_messages ADD COLUMN delivered_at TEXT');
if (!messageColumns.has('read_at')) db.exec('ALTER TABLE chat_messages ADD COLUMN read_at TEXT');

// Safe, additive migration: old accounts, requests and quote history remain in place.
const rideColumns = db.prepare('PRAGMA table_info(ride_requests)').all().map(c => c.name);
if (!rideColumns.includes('price_cents')) db.exec('ALTER TABLE ride_requests ADD COLUMN price_cents INTEGER');
if (!rideColumns.includes('assigned_driver_id')) db.exec('ALTER TABLE ride_requests ADD COLUMN assigned_driver_id INTEGER REFERENCES users(id)');
if (!rideColumns.includes('admin_approved_at')) db.exec('ALTER TABLE ride_requests ADD COLUMN admin_approved_at TEXT');
if (!rideColumns.includes('accepted_at')) db.exec('ALTER TABLE ride_requests ADD COLUMN accepted_at TEXT');
if (!rideColumns.includes('commission_cents')) db.exec('ALTER TABLE ride_requests ADD COLUMN commission_cents INTEGER');
if (!rideColumns.includes('driver_payout_cents')) db.exec('ALTER TABLE ride_requests ADD COLUMN driver_payout_cents INTEGER');
const existingRideColumns = new Set(rideColumns);
if (!existingRideColumns.has('service_description')) { db.exec('ALTER TABLE ride_requests ADD COLUMN service_description TEXT'); existingRideColumns.add('service_description'); }
if (!existingRideColumns.has('child_count')) { db.exec('ALTER TABLE ride_requests ADD COLUMN child_count INTEGER NOT NULL DEFAULT 0'); existingRideColumns.add('child_count'); }
if (!existingRideColumns.has('garden_hours')) { db.exec('ALTER TABLE ride_requests ADD COLUMN garden_hours REAL'); existingRideColumns.add('garden_hours'); }
for (const [column, definition] of Object.entries({
 garden_task: 'TEXT', garden_size_m2: 'REAL', moving_task: 'TEXT',
 pickup_floor: 'TEXT', destination_floor: 'TEXT', pickup_elevator: 'INTEGER',
 destination_elevator: 'INTEGER', item_count: 'INTEGER', need_helpers: 'INTEGER', need_van: 'INTEGER',
 child_seats_needed: 'INTEGER NOT NULL DEFAULT 0', child_ages_heights: 'TEXT', child_seat_provider: 'TEXT', photos_json: 'TEXT'
})) {
 if (!existingRideColumns.has(column)) { db.exec(`ALTER TABLE ride_requests ADD COLUMN ${column} ${definition}`); existingRideColumns.add(column); }
}

async function ensureAdmin() {
 const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
 const password = process.env.ADMIN_PASSWORD || '';
 if (!email || !password) { console.warn('ADMIN_EMAIL/ADMIN_PASSWORD not configured; admin bootstrap skipped.'); return; }
 const existing = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
 if (!existing) {
  const hash = await bcrypt.hash(password, 12);
  db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,'admin')").run('HelferFix Admin', email, hash);
  console.log(`Initial admin created for ${email}.`);
 }
}
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));
if (isProduction) app.set('trust proxy', 1);
app.use(session({
 secret: process.env.SESSION_SECRET || 'development-only-secret-change-me-now-please',
 resave: false, saveUninitialized: false,
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
 const user=currentUser(req); if (!user || !user.active) return res.status(401).json({error:'Bitte melde dich an.'}); req.user=user; next();
}
function requireRole(...roles) {
 return (req,res,next)=>{ const user=currentUser(req); if(!user||!user.active)return res.status(401).json({error:'Bitte melde dich an.'}); if(!roles.includes(user.role))return res.status(403).json({error:'Keine Berechtigung.'}); req.user=user; next(); };
}
function feePercent(){ const row=db.prepare("SELECT value FROM settings WHERE key='platform_fee_percent'").get(); const n=Number(row?.value ?? 10); return Number.isFinite(n)&&n>=0&&n<=30?n:10; }
function withMoney(ride){
 const { photos_json, ...rideData } = ride;
 let photosCount = 0;
 try { photosCount = photos_json ? JSON.parse(photos_json).length : 0; } catch {}
 const price=Number.isInteger(ride.price_cents)?ride.price_cents:null;
 const pct=feePercent();
 const commission=price===null?null:Math.round(price*pct/100);
 return {...rideData, photosCount, priceEuro:price===null?null:(price/100).toFixed(2), commissionPercent:pct,
  commissionEuro:commission===null?null:(commission/100).toFixed(2),
  driverPayoutEuro:commission===null?null:((price-commission)/100).toFixed(2)};
}
app.get('/api/health',(req,res)=>res.json({ok:true,app:'HelferFix',mode:'MVP',bookingsAreConfirmed:false}));
app.get('/api/me',(req,res)=>res.json({user:currentUser(req)}));
app.post('/api/auth/register',async(req,res)=>{
 const name=clean(req.body.name,100),email=clean(req.body.email,254).toLowerCase(),password=typeof req.body.password==='string'?req.body.password:'',role=req.body.role;
 if(name.length<2||!emailOk(email)||password.length<8||password.length>200||password!==String(req.body.confirmPassword||'')||!['customer','driver'].includes(role))return res.status(400).json({error:'Bitte Name, gültige E-Mail, Passwort (mind. 8 Zeichen) und passende Bestätigung und Rolle korrekt angeben.'});
 try{const hash=await bcrypt.hash(password,12);const result=db.prepare('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)').run(name,email,hash,role);
  req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Sitzung konnte nicht erstellt werden.'});req.session.userId=Number(result.lastInsertRowid);res.status(201).json({user:currentUser(req),message:'Konto erstellt. Angaben des Dienstleisters sind noch nicht geprüft.'});});
 }catch(e){if(String(e.code).includes('SQLITE_CONSTRAINT_UNIQUE'))return res.status(409).json({error:'Diese E-Mail-Adresse ist bereits registriert.'});console.error(e);res.status(500).json({error:'Registrierung fehlgeschlagen.'});}
});
app.post('/api/auth/login',async(req,res)=>{
 const email=clean(req.body.email,254).toLowerCase(),password=typeof req.body.password==='string'?req.body.password:'';const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
 if(!user||!user.active||!(await bcrypt.compare(password,user.password_hash)))return res.status(401).json({error:'E-Mail oder Passwort ist falsch.'});
 req.session.regenerate(err=>{if(err)return res.status(500).json({error:'Anmeldung fehlgeschlagen.'});req.session.userId=user.id;res.json({user:currentUser(req),message:'Erfolgreich angemeldet.'});});
});
app.post('/api/auth/logout',(req,res)=>req.session.destroy(()=>{res.clearCookie('connect.sid');res.json({ok:true,message:'Abgemeldet.'});}));

// Customer requests: service-specific details are saved; all requests wait for admin approval.
app.post('/api/rides',requireRole('customer'),(req,res)=>{
 const serviceType=['airport','garden','moving','multi'].includes(req.body.serviceType)?req.body.serviceType:'airport';
 const pickup=clean(req.body.pickup,180) || (serviceType==='multi'?'—':'');
 const destination=clean(req.body.destination,180) || (serviceType==='garden'||serviceType==='multi'?pickup:'');
 const serviceDescription=clean(req.body.serviceDescription,2000);
 const gardenHours=req.body.gardenHours===''||req.body.gardenHours==null?null:Number(req.body.gardenHours);
 const travelDate=clean(req.body.travelDate,10),travelTime=clean(req.body.travelTime,5);
 const passengers=Number(req.body.passengers),luggage=Number(req.body.luggage);
 const childCount=Number(req.body.childCount||0);
 const vehicleType=['PKW','Van','egal'].includes(req.body.vehicleType)?req.body.vehicleType:'PKW';
 const notes=clean(req.body.notes,1000),price=Number(req.body.priceEuro);
 const photos=req.body.photos==null?[]:req.body.photos;
 if(!Array.isArray(photos)||photos.length>3||photos.some(photo=>!photo||typeof photo!=='object'||typeof photo.name!=='string'||photo.name.length>120||!['image/jpeg','image/png','image/webp'].includes(photo.type)||typeof photo.data!=='string'||photo.data.length>1400000||!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo.data)))return res.status(400).json({error:'Bitte lade höchstens 3 JPG-, PNG- oder WebP-Bilder mit jeweils maximal 1 MB hoch.'});
 const photosJson=photos.length?JSON.stringify(photos.map(photo=>({name:clean(photo.name,120),type:photo.type,data:photo.data}))):null;
 const gardenTask=['lawn','hedge','cleaning','other'].includes(req.body.gardenTask)?req.body.gardenTask:null;
 const gardenSize=req.body.gardenSizeM2===''||req.body.gardenSizeM2==null?null:Number(req.body.gardenSizeM2);
 const movingTask=['move','assembly','both'].includes(req.body.movingTask)?req.body.movingTask:null;
 const pickupFloor=clean(req.body.pickupFloor,30),destinationFloor=clean(req.body.destinationFloor,30);
 const pickupElevator=req.body.pickupElevator===true?1:req.body.pickupElevator===false?0:null;
 const destinationElevator=req.body.destinationElevator===true?1:req.body.destinationElevator===false?0:null;
 const itemCount=req.body.itemCount===''||req.body.itemCount==null?null:Number(req.body.itemCount);
 const needHelpers=req.body.needHelpers===true?1:req.body.needHelpers===false?0:null;
 const needVan=req.body.needVan===true?1:req.body.needVan===false?0:null;
 const childSeatsNeeded=Number(req.body.childSeatsNeeded||0);
 const childAgesHeights=clean(req.body.childAgesHeights,200);
 const childSeatProvider=['customer','driver','none'].includes(req.body.childSeatProvider)?req.body.childSeatProvider:'none';
 if((serviceType!=='multi'&&(!pickup||pickup.length<2))||((serviceType==='airport'||serviceType==='moving')&&(!destination||destination.length<2)))return res.status(400).json({error:'Bitte Start/Ort und – falls erforderlich – Ziel korrekt angeben.'});
 if(!travelDate||!/^\d{4}-\d{2}-\d{2}$/.test(travelDate)||!travelTime||!/^([01]\d|2[0-3]):[0-5]\d$/.test(travelTime))return res.status(400).json({error:'Bitte Datum und Uhrzeit angeben.'});
 // Reject past dates/times using the local German time zone, regardless of the server's UTC clock.
 const berlinNow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).replace(' ', 'T');
 if (`${travelDate}T${travelTime}` < berlinNow) return res.status(400).json({error:'Das Datum und die Uhrzeit müssen in der Zukunft liegen.'});
 if(serviceType==='multi'&&serviceDescription.length<5)return res.status(400).json({error:'Bitte beschreibe die gewünschte Dienstleistung (mindestens 5 Zeichen).'});
 if(gardenHours!==null&&(!Number.isFinite(gardenHours)||gardenHours<0.5||gardenHours>100))return res.status(400).json({error:'Bitte prüfe die geschätzten Gartenstunden.'});
 if(serviceType==='airport'&&(!Number.isInteger(passengers)||passengers<1||passengers>8||!Number.isInteger(luggage)||luggage<0||luggage>20))return res.status(400).json({error:'Bitte prüfe Personen und Gepäck.'});
 if(serviceType==='airport'&&(!Number.isInteger(childCount)||childCount<0||childCount>8||childCount>passengers))return res.status(400).json({error:'Bitte prüfe die Anzahl der Kinder.'});
 if(!Number.isFinite(price)||price<1||price>10000||Math.round(price*100)!==price*100)return res.status(400).json({error:'Bitte gib einen gültigen Preis von mindestens 1 Euro ein.'});
 if(gardenSize!==null&&(!Number.isFinite(gardenSize)||gardenSize<0||gardenSize>100000))return res.status(400).json({error:'Bitte prüfe die Gartengröße.'});
 if(itemCount!==null&&(!Number.isInteger(itemCount)||itemCount<1||itemCount>1000))return res.status(400).json({error:'Bitte prüfe die Anzahl der Möbelstücke.'});
 if(serviceType==='garden'&&!gardenTask)return res.status(400).json({error:'Bitte wähle die Gartenarbeit aus.'});
 if(serviceType==='moving'&&(!movingTask||!pickupFloor||!destinationFloor||pickupElevator===null||destinationElevator===null||needHelpers===null||needVan===null))return res.status(400).json({error:'Bitte fülle die Angaben zum Umzug aus.'});
 if(serviceType==='airport'&&(!Number.isInteger(childSeatsNeeded)||childSeatsNeeded<0||childSeatsNeeded>8||childSeatsNeeded>childCount))return res.status(400).json({error:'Bitte prüfe die Anzahl der benötigten Kindersitze.'});
 if(serviceType==='airport'&&childCount>0&&!childAgesHeights)return res.status(400).json({error:'Bitte gib Alter und möglichst Körpergröße der Kinder an, die einen Kindersitz benötigen.'});
 if(travelDate&&!/^\d{4}-\d{2}-\d{2}$/.test(travelDate))return res.status(400).json({error:'Ungültiges Datum.'});
 const cents=Math.round(price*100),pct=feePercent(),commission=Math.round(cents*pct/100);
 const result=db.prepare(`INSERT INTO ride_requests (
 customer_id,service_type,pickup,destination,travel_date,travel_time,passengers,luggage,vehicle_type,notes,
 price_cents,commission_cents,driver_payout_cents,status,garden_task,garden_size_m2,moving_task,pickup_floor,destination_floor,
 pickup_elevator,destination_elevator,item_count,need_helpers,need_van,child_seats_needed,child_ages_heights,child_seat_provider,photos_json,service_description,garden_hours,child_count
 ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'new',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
 .run(req.user.id,serviceType,pickup,destination,travelDate,travelTime,
  serviceType==='airport'?passengers:0,serviceType==='airport'?luggage:0,serviceType==='airport'?vehicleType:'',notes||null,
  cents,commission,cents-commission,gardenTask,gardenSize,movingTask,pickupFloor||null,destinationFloor||null,
  pickupElevator,destinationElevator,itemCount,needHelpers,needVan,
  serviceType==='airport'?childSeatsNeeded:0,serviceType==='airport'?(childAgesHeights||null):null,serviceType==='airport'?childSeatProvider:'none',photosJson,serviceType==='multi'?serviceDescription:null,serviceType==='garden'?gardenHours:null,serviceType==='airport'?childCount:0);
 res.status(201).json({id:Number(result.lastInsertRowid),status:'new',priceEuro:(cents/100).toFixed(2),commissionEuro:(commission/100).toFixed(2),driverPayoutEuro:((cents-commission)/100).toFixed(2),message:'Anfrage gespeichert. Sie wird erst nach Freigabe durch den Admin für Fahrer sichtbar; noch keine Fahrt bestätigt.'});
});
app.get('/api/rides/:id/photos',requireRole('customer','driver','admin'),(req,res)=>{
 const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Ungültige Anfrage.'});
 const ride=db.prepare('SELECT * FROM ride_requests WHERE id=?').get(id);if(!ride)return res.status(404).json({error:'Anfrage nicht gefunden.'});
 const allowed=req.user.role==='admin'||(req.user.role==='customer'&&ride.customer_id===req.user.id)||(req.user.role==='driver'&&((ride.status==='quoted'&&ride.assigned_driver_id==null)||(ride.status==='accepted'&&ride.assigned_driver_id===req.user.id)));
 if(!allowed)return res.status(403).json({error:'Keine Berechtigung.'});
 let photos=[];try{photos=ride.photos_json?JSON.parse(ride.photos_json):[];}catch{photos=[];}
 res.json({photos:photos.map(photo=>({name:clean(photo.name,120),type:photo.type,data:photo.data}))});
});
app.get('/api/rides/mine',requireRole('customer'),(req,res)=>{
 const rides=db.prepare('SELECT r.*,u.name AS driver_name FROM ride_requests r LEFT JOIN users u ON u.id=r.assigned_driver_id WHERE r.customer_id=? ORDER BY r.id DESC').all(req.user.id);
 res.json({rides:rides.map(withMoney)});
});
app.post('/api/rides/:id/repost',requireRole('customer'),(req,res)=>{
 const id=Number(req.params.id);if(!Number.isInteger(id))return res.status(400).json({error:'Ungültige Anfrage.'});
 const ride=db.prepare('SELECT * FROM ride_requests WHERE id=? AND customer_id=?').get(id,req.user.id);
 if(!ride)return res.status(404).json({error:'Anfrage nicht gefunden.'});
 if(!['cancelled'].includes(ride.status))return res.status(409).json({error:'Nur stornierte Anfragen können erneut eingereicht werden.'});
 const result=db.prepare("UPDATE ride_requests SET status='new',assigned_driver_id=NULL,accepted_at=NULL,admin_approved_at=NULL WHERE id=? AND customer_id=? AND status='cancelled'").run(id,req.user.id);
 if(!result.changes)return res.status(409).json({error:'Anfrage wurde zwischenzeitlich geändert.'});
 res.json({message:'Anfrage erneut eingereicht und wartet auf Admin-Freigabe.'});
});
// Drivers see only admin-approved requests. Price is fixed; there is no driver price-offer route.
app.get('/api/rides/open',requireRole('driver'),(req,res)=>{
 const rides=db.prepare("SELECT r.* FROM ride_requests r WHERE r.status='quoted' AND r.assigned_driver_id IS NULL AND EXISTS (SELECT 1 FROM users c WHERE c.id=r.customer_id AND c.active=1) ORDER BY r.id DESC").all();
 res.json({rides:rides.map(withMoney)});
});
// Atomic conditional update: only one driver can claim a request.
app.post('/api/rides/:id/accept',requireRole('driver'),(req,res)=>{
 const id=Number(req.params.id);if(!Number.isInteger(id))return res.status(400).json({error:'Ungültige Anfrage.'});
 const tx=db.transaction(()=>{
  const result=db.prepare("UPDATE ride_requests SET status='accepted',assigned_driver_id=?,accepted_at=CURRENT_TIMESTAMP WHERE id=? AND status='quoted' AND assigned_driver_id IS NULL").run(req.user.id,id);
  if(!result.changes)return false;
  return true;
 });
 if(!tx())return res.status(409).json({error:'Diese Anfrage wurde bereits angenommen oder ist nicht mehr verfügbar.'});
 res.json({message:'Du hast die Anfrage übernommen. Bitte kläre alle Einzelheiten mit dem Kunden.'});
});
app.post('/api/rides/:id/cancel',requireRole('driver'),(req,res)=>{
 const id=Number(req.params.id);if(!Number.isInteger(id))return res.status(400).json({error:'Ungültige Anfrage.'});
 const tx=db.transaction(()=>{
  const result=db.prepare("UPDATE ride_requests SET status='quoted',assigned_driver_id=NULL,accepted_at=NULL WHERE id=? AND status='accepted' AND assigned_driver_id=?").run(id,req.user.id);
  return result.changes;
 });
 if(!tx())return res.status(409).json({error:'Diese Anfrage ist dir nicht zugeordnet oder wurde bereits geändert.'});
 res.json({message:'Anfrage wieder für andere Fahrer freigegeben.'});
});
app.get('/api/rides/assigned',requireRole('driver'),(req,res)=>{
 const rides=db.prepare("SELECT r.*,u.name AS customer_name FROM ride_requests r JOIN users u ON u.id=r.customer_id WHERE r.assigned_driver_id=? AND r.status='accepted' ORDER BY r.id DESC").all(req.user.id);
 res.json({rides:rides.map(withMoney)});
});
// Old quote routes are intentionally disabled so drivers cannot counteroffer.
app.post('/api/rides/:id/quotes',requireRole('driver'),(req,res)=>res.status(410).json({error:'Preisangebote sind deaktiviert. Der Kundenpreis ist fest.'}));
app.get('/api/rides/:id/quotes',requireRole('customer','admin'),(req,res)=>{
 const id=Number(req.params.id),ride=db.prepare('SELECT * FROM ride_requests WHERE id=?').get(id);if(!ride)return res.status(404).json({error:'Anfrage nicht gefunden.'});
 if(req.user.role!=='admin'&&ride.customer_id!==req.user.id)return res.status(403).json({error:'Keine Berechtigung.'});
 const quotes=db.prepare('SELECT q.id,q.price_cents,q.message,q.status,q.created_at,u.name AS driver_name FROM quotes q JOIN users u ON u.id=q.driver_id WHERE q.ride_request_id=? ORDER BY q.created_at DESC').all(id);
 res.json({quotes:quotes.map(q=>({...q,priceEuro:(q.price_cents/100).toFixed(2)}))});
});
app.post('/api/quotes/:id/accept',requireRole('customer'),(req,res)=>res.status(410).json({error:'Das alte Angebotssystem ist deaktiviert. Der Admin gibt Anfragen frei und Fahrer akzeptieren den festen Kundenpreis.'}));

// Private in-site chat: only the customer and the currently assigned driver can read/write.
function getChatRide(id) {
 return db.prepare("SELECT id,customer_id,assigned_driver_id,status FROM ride_requests WHERE id=?").get(id);
}
function canUseChat(ride,user) {
 return !!ride && ride.status==='accepted' && ride.assigned_driver_id!=null &&
  (user.role==='customer' && ride.customer_id===user.id || user.role==='driver' && ride.assigned_driver_id===user.id);
}
app.get('/api/rides/:id/messages',requireRole('customer','driver'),(req,res)=>{
 const id=Number(req.params.id); if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Ungültige Anfrage.'});
 const ride=getChatRide(id); if(!ride)return res.status(404).json({error:'Anfrage nicht gefunden.'});
 if(!canUseChat(ride,req.user))return res.status(403).json({error:'Der Chat ist nur für den Kunden und den zugeordneten Fahrer eines angenommenen Auftrags verfügbar.'});
 const recipientCondition = 'sender_id<>?';
 db.prepare(`UPDATE chat_messages SET delivered_at=COALESCE(delivered_at,CURRENT_TIMESTAMP), read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE ride_request_id=? AND ${recipientCondition}`).run(id,req.user.id);
 db.prepare('UPDATE chat_notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE recipient_id=? AND ride_request_id=? AND read_at IS NULL').run(req.user.id,id);
 const messages=db.prepare('SELECT m.id,m.sender_id,m.message,m.created_at,m.delivered_at,m.read_at,u.name AS sender_name FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.ride_request_id=? ORDER BY m.id DESC LIMIT 200').all(id).reverse();
 res.json({messages});
});
app.post('/api/rides/:id/messages',requireRole('customer','driver'),(req,res)=>{
 const id=Number(req.params.id); if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Ungültige Anfrage.'});
 const ride=getChatRide(id); if(!ride)return res.status(404).json({error:'Anfrage nicht gefunden.'});
 if(!canUseChat(ride,req.user))return res.status(403).json({error:'Der Chat ist nur für den Kunden und den zugeordneten Fahrer eines angenommenen Auftrags verfügbar.'});
 const message=typeof req.body.message==='string'?req.body.message.trim():'';
 if(!message||message.length>2000)return res.status(400).json({error:'Bitte gib eine Nachricht mit 1 bis 2000 Zeichen ein.'});
 const result=db.prepare('INSERT INTO chat_messages(ride_request_id,sender_id,message) VALUES(?,?,?)').run(id,req.user.id,message);
 const recipientId=req.user.role==='customer'?ride.assigned_driver_id:ride.customer_id;
 db.prepare('INSERT INTO chat_notifications(recipient_id,ride_request_id,message_id) VALUES(?,?,?)').run(recipientId,id,Number(result.lastInsertRowid));
 const saved=db.prepare('SELECT m.id,m.sender_id,m.message,m.created_at,m.delivered_at,m.read_at,u.name AS sender_name FROM chat_messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?').get(Number(result.lastInsertRowid));
 res.status(201).json({message:saved});
});

// In-app unread chat notifications for the other participant.
app.get('/api/notifications/unread',requireRole('customer','driver'),(req,res)=>{
 db.prepare(`UPDATE chat_messages SET delivered_at=COALESCE(delivered_at,CURRENT_TIMESTAMP) WHERE id IN (SELECT message_id FROM chat_notifications WHERE recipient_id=? AND read_at IS NULL)`).run(req.user.id);
 const rows=db.prepare(`SELECT n.id,n.ride_request_id,n.message_id,n.created_at,m.message,u.name AS sender_name FROM chat_notifications n JOIN chat_messages m ON m.id=n.message_id JOIN users u ON u.id=m.sender_id WHERE n.recipient_id=? AND n.read_at IS NULL ORDER BY n.id DESC LIMIT 30`).all(req.user.id);
 res.json({notifications:rows});
});
app.post('/api/notifications/read',requireRole('customer','driver'),(req,res)=>{
 const ids=Array.isArray(req.body.ids)?req.body.ids.map(Number).filter(n=>Number.isInteger(n)&&n>0).slice(0,100):[];
 if(ids.length){const marks=ids.map(()=>'?').join(',');db.prepare(`UPDATE chat_notifications SET read_at=CURRENT_TIMESTAMP WHERE recipient_id=? AND id IN (${marks})`).run(req.user.id,...ids);}
 res.json({ok:true});
});

app.get('/api/admin/summary',requireRole('admin'),(req,res)=>res.json({
 users:db.prepare('SELECT COUNT(*) n FROM users').get().n,
 drivers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='driver'").get().n,
 customers:db.prepare("SELECT COUNT(*) n FROM users WHERE role='customer'").get().n,
 rides:db.prepare('SELECT COUNT(*) n FROM ride_requests').get().n,
 newRides:db.prepare("SELECT COUNT(*) n FROM ride_requests WHERE status='new'").get().n,
 availableRides:db.prepare("SELECT COUNT(*) n FROM ride_requests WHERE status='quoted'").get().n
}));
app.get('/api/admin/users',requireRole('admin'),(req,res)=>res.json({users:db.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY id DESC LIMIT 500').all()}));
app.patch('/api/admin/users/:id',requireRole('admin'),(req,res)=>{
 const id=Number(req.params.id),active=req.body.active;if(!Number.isInteger(id)||typeof active!=='boolean')return res.status(400).json({error:'Ungültige Daten.'});
 const target=db.prepare('SELECT id,role FROM users WHERE id=?').get(id);if(!target)return res.status(404).json({error:'Nutzer nicht gefunden.'});if(target.role==='admin')return res.status(400).json({error:'Admin-Konten können hier nicht deaktiviert werden.'});
 db.prepare('UPDATE users SET active=? WHERE id=?').run(active?1:0,id);
 if(!active&&target.role==='driver')db.prepare("UPDATE ride_requests SET status='quoted',assigned_driver_id=NULL,accepted_at=NULL WHERE status='accepted' AND assigned_driver_id=?").run(id);
 res.json({message:active?'Nutzer aktiviert.':'Nutzer deaktiviert.'});
});
app.get('/api/admin/rides',requireRole('admin'),(req,res)=>{
 const rides=db.prepare('SELECT r.*,u.name AS customer_name,u.email AS customer_email,d.name AS driver_name FROM ride_requests r JOIN users u ON u.id=r.customer_id LEFT JOIN users d ON d.id=r.assigned_driver_id ORDER BY r.id DESC LIMIT 500').all();
 res.json({rides:rides.map(withMoney)});
});
app.patch('/api/admin/rides/:id',requireRole('admin'),(req,res)=>{
 const id=Number(req.params.id),status=req.body.status;
 if(!Number.isInteger(id)||!['new','quoted','accepted','cancelled','completed'].includes(status))return res.status(400).json({error:'Ungültiger Status.'});
 const ride=db.prepare('SELECT * FROM ride_requests WHERE id=?').get(id);if(!ride)return res.status(404).json({error:'Anfrage nicht gefunden.'});
 if(status==='accepted')return res.status(400).json({error:'Der Status „Angenommen“ wird nur gesetzt, wenn ein Fahrer die Anfrage selbst annimmt.'});
 if(status==='quoted'&&(!Number.isInteger(ride.price_cents)||ride.price_cents<100))return res.status(400).json({error:'Diese alte Anfrage hat keinen festgelegten Kundenpreis. Bitte erstelle eine neue Anfrage.'});
 if(status==='quoted'&&ride.status==='accepted')return res.status(409).json({error:'Bitte lasse den Fahrer die Anfrage zuerst freigeben.'});
 const approvedAt=status==='quoted'?(ride.admin_approved_at||new Date().toISOString()):ride.admin_approved_at;
 db.prepare('UPDATE ride_requests SET status=?,admin_approved_at=?,assigned_driver_id=CASE WHEN ? IN (\'new\',\'cancelled\',\'completed\') THEN NULL ELSE assigned_driver_id END,accepted_at=CASE WHEN ? IN (\'new\',\'cancelled\',\'completed\') THEN NULL ELSE accepted_at END WHERE id=?').run(status,approvedAt,status,status,id);
 res.json({message:status==='quoted'?'Anfrage freigegeben und für Fahrer sichtbar.':status==='cancelled'?'Anfrage storniert.':status==='completed'?'Anfrage abgeschlossen.':'Status aktualisiert.'});
});
app.get('/api/admin/settings',requireRole('admin'),(req,res)=>{
 const rows=db.prepare('SELECT key,value,updated_at FROM settings ORDER BY key').all(),values=Object.fromEntries(rows.map(r=>[r.key,r.value]));
 res.json({settings:{site_name:values.site_name||'HelferFix',platform_fee_percent:values.platform_fee_percent||'10',support_email:values.support_email||''}});
});
app.put('/api/admin/settings',requireRole('admin'),(req,res)=>{
 const siteName=clean(req.body.site_name,80),supportEmail=clean(req.body.support_email,254),fee=Number(req.body.platform_fee_percent);
 if(!siteName||!Number.isFinite(fee)||fee<0||fee>30||(supportEmail&&!emailOk(supportEmail)))return res.status(400).json({error:'Bitte prüfe Name, E-Mail und Gebühr (0–30 %).'});
 const save=db.transaction(()=>{for(const [key,value] of Object.entries({site_name:siteName,platform_fee_percent:String(fee),support_email:supportEmail}))db.prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP').run(key,value);});
 save();res.json({message:'Einstellungen gespeichert. Die Provision wird nur berechnet, nicht eingezogen.'});
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Interner Fehler.'});});
ensureAdmin().then(()=>app.listen(PORT,()=>console.log(`HelferFix läuft unter http://localhost:${PORT}`))).catch(err=>{console.error(err);process.exit(1);});
