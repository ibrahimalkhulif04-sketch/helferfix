'use strict';

/* HelferFix – Fresh backend for the current public/index.html
 * Node 20+, Express, express-session, connect-sqlite3, better-sqlite3,
 * bcryptjs, dotenv, express-rate-limit and helmet.
 * Existing SQLite data is preserved through additive migrations.
 */

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
const production = process.env.NODE_ENV === 'production';

const DATA_DIR = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, 'data')
);

const DB_FILE = path.resolve(
  process.env.DB_FILE || path.join(DATA_DIR, 'helferfix.sqlite')
);

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');


/* =========================================================
   DATABASE
========================================================= */

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
 pickup TEXT NOT NULL DEFAULT '',
 destination TEXT NOT NULL DEFAULT '',
 travel_date TEXT,
 travel_time TEXT,
 passengers INTEGER NOT NULL DEFAULT 0,
 luggage INTEGER NOT NULL DEFAULT 0,
 vehicle_type TEXT NOT NULL DEFAULT 'PKW',
 notes TEXT,
 status TEXT NOT NULL DEFAULT 'new'
 CHECK(status IN ('new','quoted','accepted','cancelled','completed')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 ride_request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 sender_id INTEGER NOT NULL REFERENCES users(id),
 message TEXT NOT NULL CHECK(length(message) BETWEEN 1 AND 2000),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_notifications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 ride_request_id INTEGER NOT NULL REFERENCES ride_requests(id) ON DELETE CASCADE,
 message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 read_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_ride
ON chat_messages(ride_request_id,id);

CREATE INDEX IF NOT EXISTS idx_chat_notifications_user
ON chat_notifications(recipient_id,read_at,id);
`);


/* =========================================================
   SAFE DATABASE MIGRATIONS
   No existing user or request data is deleted.
========================================================= */

function columns(table) {
  return new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name)
  );
}

function addColumn(table, name, declaration) {
  if (!columns(table).has(name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${declaration}`);
  }
}

for (const [name, declaration] of Object.entries({
  price_cents: 'INTEGER',
  assigned_driver_id: 'INTEGER REFERENCES users(id)',
  admin_approved_at: 'TEXT',
  accepted_at: 'TEXT',
  commission_cents: 'INTEGER',
  driver_payout_cents: 'INTEGER',
  service_description: 'TEXT',
  garden_task: 'TEXT',
  garden_size_m2: 'REAL',
  garden_hours: 'REAL',
  moving_task: 'TEXT',
  pickup_floor: 'TEXT',
  destination_floor: 'TEXT',
  pickup_elevator: 'INTEGER',
  destination_elevator: 'INTEGER',
  item_count: 'INTEGER',
  need_helpers: 'INTEGER',
  need_van: 'INTEGER',
  child_seats_needed: 'INTEGER NOT NULL DEFAULT 0',
  child_ages_heights: 'TEXT',
  photos_json: 'TEXT'
})) {
  addColumn('ride_requests', name, declaration);
}

addColumn(
  'ride_requests',
  'child_seat_provider',
  "TEXT NOT NULL DEFAULT 'none'"
);


/* =========================================================
   HELPERS
========================================================= */

const text = (v, max = 500) =>
  typeof v === 'string' ? v.trim().slice(0, max) : '';

const emailValid = v =>
  typeof v === 'string' &&
  v.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

const intIn = (v, min, max) =>
  Number.isInteger(Number(v)) &&
  Number(v) >= min &&
  Number(v) <= max;

const boolOrNull = v =>
  v === true ? 1 : v === false ? 0 : null;


function berlinNow() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());

  const values = Object.fromEntries(
    parts.map(x => [x.type, x.value])
  );

  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}


function validFuture(date, time) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date || '') ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')
  ) {
    return false;
  }

  const d = new Date(`${date}T${time}:00`);

  return (
    Number.isFinite(d.getTime()) &&
    d.toISOString().slice(0, 10) === date &&
    `${date}T${time}` > berlinNow()
  );
}


function feePercent() {
  const row = db.prepare(
    "SELECT value FROM settings WHERE key='platform_fee_percent'"
  ).get();

  const n = Number(row?.value ?? 10);

  return Number.isFinite(n) && n >= 0 && n <= 30 ? n : 10;
}


function publicUser(row) {
  return row ? {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    active: !!row.active,
    created_at: row.created_at
  } : null;
}


function getUser(req) {
  if (!req.session.userId) return null;

  return db.prepare(
    'SELECT id,name,email,role,active,created_at FROM users WHERE id=?'
  ).get(req.session.userId) || null;
}


function auth(req, res, next) {
  const user = getUser(req);

  if (!user || !user.active) {
    return res.status(401).json({
      error: 'Bitte melde dich an.'
    });
  }

  req.user = user;
  next();
}


function roles(...allowed) {
  return (req, res, next) => {
    const user = getUser(req);

    if (!user || !user.active) {
      return res.status(401).json({
        error: 'Bitte melde dich an.'
      });
    }

    if (!allowed.includes(user.role)) {
      return res.status(403).json({
        error: 'Keine Berechtigung.'
      });
    }

    req.user = user;
    next();
  };
}


function rideView(r) {
  const pct = feePercent();

  const cents = Number.isInteger(r.price_cents)
    ? r.price_cents
    : null;

  const commission = cents === null
    ? null
    : Math.round(cents * pct / 100);

  let photosCount = 0;

  try {
    photosCount = r.photos_json
      ? JSON.parse(r.photos_json).length
      : 0;
  } catch (_) {}

  const { photos_json, ...rest } = r;

  return {
    ...rest,
    photosCount,

    priceEuro: cents === null
      ? null
      : (cents / 100).toFixed(2),

    commissionPercent: pct,

    commissionEuro: commission === null
      ? null
      : (commission / 100).toFixed(2),

    driverPayoutEuro: commission === null
      ? null
      : ((cents - commission) / 100).toFixed(2)
  };
}


function parsePhotos(value) {
  if (value == null) {
    return {
      ok: true,
      value: null,
      count: 0
    };
  }

  if (!Array.isArray(value) || value.length > 3) {
    return { ok: false };
  }

  const photos = [];

  for (const p of value) {
    if (
      !p ||
      typeof p !== 'object' ||
      !['image/jpeg', 'image/png', 'image/webp'].includes(p.type) ||
      typeof p.name !== 'string' ||
      typeof p.data !== 'string'
    ) {
      return { ok: false };
    }

    if (
      p.name.length > 120 ||
      p.data.length > 1400000 ||
      !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(p.data)
    ) {
      return { ok: false };
    }

    const raw = Buffer.from(p.data.split(',')[1], 'base64');

    if (!raw.length || raw.length > 1024 * 1024) {
      return { ok: false };
    }

    photos.push({
      name: text(p.name, 120),
      type: p.type,
      data: p.data
    });
  }

  return {
    ok: true,
    value: photos.length ? JSON.stringify(photos) : null,
    count: photos.length
  };
}


/* =========================================================
   EXPRESS CONFIGURATION
========================================================= */

app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false
}));

app.use(express.json({
  limit: '6mb'
}));

app.use(express.urlencoded({
  extended: false,
  limit: '30kb'
}));

if (production) {
  app.set('trust proxy', 1);
}

app.use(session({
  name: 'helferfix.sid',

  secret: process.env.SESSION_SECRET ||
    (production
      ? (() => { throw new Error('SESSION_SECRET fehlt.'); })()
      : 'local-development-secret-change-this'),

  resave: false,
  saveUninitialized: false,

  store: new SQLiteStoreFactory({
    db: 'sessions.sqlite',
    dir: DATA_DIR
  }),

  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: production,
    maxAge: 12 * 60 * 60 * 1000
  }
}));

app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false
}));

app.use(express.static(
  path.join(__dirname, 'public'),
  {
    index: 'index.html',
    maxAge: production ? '1h' : 0
  }
));


/* =========================================================
   ADMIN INITIALIZATION
   Admin is created only from environment variables.
========================================================= */

async function ensureAdmin() {
  const email = text(process.env.ADMIN_EMAIL, 254).toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';

  if (!email || !password) {
    console.warn(
      'ADMIN_EMAIL/ADMIN_PASSWORD are not configured; admin bootstrap skipped.'
    );
    return;
  }

  if (!emailValid(email) || password.length < 12) {
    throw new Error(
      'ADMIN_EMAIL ist ungültig oder ADMIN_PASSWORD ist kürzer als 12 Zeichen.'
    );
  }

  const existing = db.prepare(
    "SELECT id FROM users WHERE role='admin' LIMIT 1"
  ).get();

  if (!existing) {
    const hash = await bcrypt.hash(password, 12);

    db.prepare(
      "INSERT INTO users(name,email,password_hash,role,active) VALUES(?,?,?,'admin',1)"
    ).run('HelferFix Admin', email, hash);

    console.log('Initial admin account created.');
  }
}


/* =========================================================
   HEALTH AND USER
========================================================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'HelferFix',
    database: 'connected',
    bookingsAreConfirmed: false
  });
});


app.get('/api/me', (req, res) => {
  res.json({
    user: publicUser(getUser(req))
  });
});


/* =========================================================
   REGISTRATION
========================================================= */

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = text(req.body.name, 100);
    const email = text(req.body.email, 254).toLowerCase();

    const password =
      typeof req.body.password === 'string'
        ? req.body.password
        : '';

    const confirm =
      typeof req.body.confirmPassword === 'string'
        ? req.body.confirmPassword
        : '';

    const role = req.body.role;

    if (name.length < 2 || !emailValid(email)) {
      return res.status(400).json({
        error: 'Bitte gib einen gültigen Namen und eine gültige E-Mail-Adresse ein.'
      });
    }

    if (password.length < 8 || password.length > 200) {
      return res.status(400).json({
        error: 'Das Passwort muss mindestens 8 Zeichen enthalten.'
      });
    }

    if (password !== confirm) {
      return res.status(400).json({
        error: 'Die Passwörter stimmen nicht überein.'
      });
    }

    if (!['customer', 'driver'].includes(role)) {
      return res.status(400).json({
        error: 'Ungültiger Kontotyp.'
      });
    }

    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
      return res.status(409).json({
        error: 'Diese E-Mail-Adresse ist bereits registriert.'
      });
    }

    const hash = await bcrypt.hash(password, 12);

    // The current index.html signs new accounts in immediately.
    // Admin can manage provider accounts through the existing user switch.
    const active = 1;

    const result = db.prepare(
      'INSERT INTO users(name,email,password_hash,role,active) VALUES(?,?,?,?,?)'
    ).run(name, email, hash, role, active);

    req.session.regenerate(err => {
      if (err) return next(err);

      req.session.userId = Number(result.lastInsertRowid);

      res.status(201).json({
        user: publicUser(getUser(req)),
        message: 'Konto erstellt.'
      });
    });

  } catch (err) {
    next(err);
  }
});


/* =========================================================
   LOGIN AND LOGOUT
========================================================= */

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = text(req.body.email, 254).toLowerCase();

    const password =
      typeof req.body.password === 'string'
        ? req.body.password
        : '';

    const user = db.prepare(
      'SELECT * FROM users WHERE email=?'
    ).get(email);

    if (
      !user ||
      !(await bcrypt.compare(password, user.password_hash))
    ) {
      return res.status(401).json({
        error: 'E-Mail oder Passwort ist falsch.'
      });
    }

    if (!user.active) {
      return res.status(403).json({
        error: 'Dein Dienstleisterkonto ist derzeit deaktiviert.'
      });
    }

    req.session.regenerate(err => {
      if (err) return next(err);

      req.session.userId = user.id;

      res.json({
        user: publicUser(getUser(req)),
        message: 'Erfolgreich angemeldet.'
      });
    });

  } catch (err) {
    next(err);
  }
});


app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).json({
        error: 'Abmeldung fehlgeschlagen.'
      });
    }

    res.clearCookie('helferfix.sid');

    res.json({
      ok: true,
      message: 'Abgemeldet.'
    });
  });
});


/* =========================================================
   CREATE SERVICE REQUEST
========================================================= */

app.post('/api/rides', roles('customer'), (req, res) => {
  const b = req.body || {};

  const type = [
    'airport',
    'garden',
    'moving',
    'multi'
  ].includes(b.serviceType)
    ? b.serviceType
    : null;

  if (!type) {
    return res.status(400).json({
      error: 'Bitte wähle eine gültige Dienstleistung.'
    });
  }

  const pickup = text(b.pickup, 180);

  const destination =
    type === 'garden' || type === 'multi'
      ? ''
      : text(b.destination, 180);

  const date = text(b.travelDate, 10);
  const time = text(b.travelTime, 5);

  if (!validFuture(date, time)) {
    return res.status(400).json({
      error: 'Datum und Uhrzeit müssen in der Zukunft liegen.'
    });
  }

  if (type !== 'multi' && pickup.length < 2) {
    return res.status(400).json({
      error: 'Bitte gib den Startort oder Ort an.'
    });
  }

  if (
    (type === 'airport' || type === 'moving') &&
    destination.length < 2
  ) {
    return res.status(400).json({
      error: 'Bitte gib das Ziel an.'
    });
  }

  const price = Number(b.priceEuro);

  if (
    !Number.isFinite(price) ||
    price < 1 ||
    price > 10000 ||
    Math.round(price * 100) !== price * 100
  ) {
    return res.status(400).json({
      error: 'Bitte gib einen gültigen Festpreis zwischen 1 und 10.000 Euro ein.'
    });
  }

  const notes = text(b.notes, 1000) || null;

  const photos = parsePhotos(b.photos);

  if (!photos.ok) {
    return res.status(400).json({
      error: 'Bitte höchstens 3 JPG-, PNG- oder WebP-Bilder mit maximal 1 MB je Bild auswählen.'
    });
  }

  let passengers = 0;
  let luggage = 0;
  let vehicle = 'PKW';

  let childSeats = 0;
  let childAges = null;
  let seatProvider = 'none';

  let gardenTask = null;
  let gardenSize = null;
  let gardenHours = null;

  let movingTask = null;
  let pickupFloor = null;
  let destinationFloor = null;
  let pickupElevator = null;
  let destinationElevator = null;
  let itemCount = null;
  let needHelpers = null;
  let needVan = null;

  let description = null;


  /* ---------- AIRPORT / GENERAL TRANSFER ---------- */

  if (type === 'airport') {
    passengers = Number(b.passengers);
    luggage = Number(b.luggage);

    vehicle = ['PKW', 'Van', 'egal'].includes(b.vehicleType)
      ? b.vehicleType
      : 'PKW';

    childSeats = Number(b.childSeatsNeeded ?? 0);

    childAges = text(b.childAgesHeights, 200) || null;

    seatProvider = [
      'customer',
      'driver',
      'none'
    ].includes(b.childSeatProvider)
      ? b.childSeatProvider
      : 'none';

    if (
      !intIn(passengers, 1, 8) ||
      !intIn(luggage, 0, 20)
    ) {
      return res.status(400).json({
        error: 'Bitte prüfe Personenanzahl und Gepäck.'
      });
    }

    if (
      !intIn(childSeats, 0, 8) ||
      (childSeats > 0 && !childAges)
    ) {
      return res.status(400).json({
        error: 'Bitte prüfe die Kindersitzanzahl und gib Alter/Größe der Kinder an.'
      });
    }
  }


  /* ---------- GARDEN ---------- */

  if (type === 'garden') {
    gardenTask = [
      'lawn',
      'hedge',
      'cleaning',
      'other'
    ].includes(b.gardenTask)
      ? b.gardenTask
      : null;

    gardenSize =
      b.gardenSizeM2 === '' || b.gardenSizeM2 == null
        ? null
        : Number(b.gardenSizeM2);

    gardenHours =
      b.gardenHours === '' || b.gardenHours == null
        ? null
        : Number(b.gardenHours);

    if (!gardenTask) {
      return res.status(400).json({
        error: 'Bitte wähle die Gartenarbeit aus.'
      });
    }

    if (
      gardenSize !== null &&
      (
        !Number.isFinite(gardenSize) ||
        gardenSize < 0 ||
        gardenSize > 100000
      )
    ) {
      return res.status(400).json({
        error: 'Bitte prüfe die Gartengröße.'
      });
    }

    if (
      gardenHours !== null &&
      (
        !Number.isFinite(gardenHours) ||
        gardenHours < 0.5 ||
        gardenHours > 100
      )
    ) {
      return res.status(400).json({
        error: 'Bitte prüfe die geschätzten Arbeitsstunden.'
      });
    }
  }


  /* ---------- MOVING AND FURNITURE ---------- */

  if (type === 'moving') {
    movingTask = [
      'move',
      'assembly',
      'both'
    ].includes(b.movingTask)
      ? b.movingTask
      : null;

    pickupFloor = text(b.pickupFloor, 30);
    destinationFloor = text(b.destinationFloor, 30);

    pickupElevator = boolOrNull(b.pickupElevator);
    destinationElevator = boolOrNull(b.destinationElevator);

    itemCount =
      b.itemCount === '' || b.itemCount == null
        ? null
        : Number(b.itemCount);

    needHelpers = boolOrNull(b.needHelpers);
    needVan = boolOrNull(b.needVan);

    if (
      !movingTask ||
      !pickupFloor ||
      !destinationFloor ||
      pickupElevator === null ||
      destinationElevator === null ||
      needHelpers === null ||
      needVan === null
    ) {
      return res.status(400).json({
        error: 'Bitte fülle alle Angaben zum Möbeltransport aus.'
      });
    }

    if (
      itemCount !== null &&
      (
        !Number.isInteger(itemCount) ||
        itemCount < 1 ||
        itemCount > 1000
      )
    ) {
      return res.status(400).json({
        error: 'Bitte prüfe die Anzahl der Möbelstücke.'
      });
    }
  }


  /* ---------- MULTIPLE / CUSTOM SERVICE ---------- */

  if (type === 'multi') {
    description = text(b.serviceDescription, 2000);

    if (description.length < 5) {
      return res.status(400).json({
        error: 'Bitte beschreibe die gewünschte Dienstleistung (mindestens 5 Zeichen).'
      });
    }
  }


  /* ---------- SAVE REQUEST ---------- */

  const cents = Math.round(price * 100);
  const pct = feePercent();
  const commission = Math.round(cents * pct / 100);

  const result = db.prepare(`
    INSERT INTO ride_requests (
      customer_id,
      service_type,
      pickup,
      destination,
      travel_date,
      travel_time,
      passengers,
      luggage,
      vehicle_type,
      notes,
      price_cents,
      commission_cents,
      driver_payout_cents,
      status,
      garden_task,
      garden_size_m2,
      garden_hours,
      moving_task,
      pickup_floor,
      destination_floor,
      pickup_elevator,
      destination_elevator,
      item_count,
      need_helpers,
      need_van,
      child_seats_needed,
      child_ages_heights,
      child_seat_provider,
      service_description,
      photos_json
    )
    VALUES (
      ?,?,?,?,?,?,?,?,?,?,?,?,?, 'new',
      ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    )
  `).run(
    req.user.id,
    type,
    pickup,
    destination,
    date,
    time,
    passengers,
    luggage,
    vehicle,
    notes,
    cents,
    commission,
    cents - commission,

    gardenTask,
    gardenSize,
    gardenHours,

    movingTask,
    pickupFloor,
    destinationFloor,
    pickupElevator,
    destinationElevator,
    itemCount,
    needHelpers,
    needVan,

    childSeats,
    childAges,
    seatProvider,

    description,
    photos.value
  );

  res.status(201).json({
    id: Number(result.lastInsertRowid),
    status: 'new',
    priceEuro: (cents / 100).toFixed(2),
    commissionEuro: (commission / 100).toFixed(2),
    driverPayoutEuro: ((cents - commission) / 100).toFixed(2),

    message:
      'Anfrage gespeichert. Sie wird erst nach Freigabe durch den Administrator für Dienstleister sichtbar. Es ist noch keine Buchung bestätigt.'
  });
});


/* =========================================================
   CUSTOMER REQUESTS
========================================================= */

app.get('/api/rides/mine', roles('customer'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,u.name AS driver_name
    FROM ride_requests r
    LEFT JOIN users u ON u.id=r.assigned_driver_id
    WHERE r.customer_id=?
    ORDER BY r.id DESC
  `).all(req.user.id);

  res.json({
    rides: rows.map(rideView)
  });
});


/* =========================================================
   PROVIDER REQUESTS
========================================================= */

app.get('/api/rides/open', roles('driver'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*
    FROM ride_requests r
    WHERE r.status='quoted'
      AND r.assigned_driver_id IS NULL
    ORDER BY r.id DESC
  `).all();

  res.json({
    rides: rows.map(rideView)
  });
});


app.get('/api/rides/assigned', roles('driver'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*,u.name AS customer_name
    FROM ride_requests r
    JOIN users u ON u.id=r.customer_id
    WHERE r.assigned_driver_id=?
      AND r.status='accepted'
    ORDER BY r.id DESC
  `).all(req.user.id);

  res.json({
    rides: rows.map(rideView)
  });
});


/* =========================================================
   ACCEPT REQUEST
========================================================= */

app.post('/api/rides/:id/accept', roles('driver'), (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      error: 'Ungültige Anfrage.'
    });
  }

  const result = db.prepare(`
    UPDATE ride_requests
    SET
      status='accepted',
      assigned_driver_id=?,
      accepted_at=CURRENT_TIMESTAMP
    WHERE id=?
      AND status='quoted'
      AND assigned_driver_id IS NULL
  `).run(req.user.id, id);

  if (!result.changes) {
    return res.status(409).json({
      error: 'Diese Anfrage ist nicht mehr verfügbar.'
    });
  }

  res.json({
    message: 'Du hast den Auftrag übernommen.'
  });
});


/* =========================================================
   PROVIDER RELEASES REQUEST
========================================================= */

app.post('/api/rides/:id/cancel', roles('driver'), (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      error: 'Ungültige Anfrage.'
    });
  }

  const result = db.prepare(`
    UPDATE ride_requests
    SET
      status='quoted',
      assigned_driver_id=NULL,
      accepted_at=NULL
    WHERE id=?
      AND status='accepted'
      AND assigned_driver_id=?
  `).run(id, req.user.id);

  if (!result.changes) {
    return res.status(409).json({
      error: 'Dieser Auftrag ist dir nicht zugeordnet oder wurde bereits geändert.'
    });
  }

  res.json({
    message: 'Auftrag wieder freigegeben.'
  });
});


/* =========================================================
   CUSTOMER REPOSTS CANCELLED REQUEST
========================================================= */

app.post('/api/rides/:id/repost', roles('customer'), (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(400).json({
      error: 'Ungültige Anfrage.'
    });
  }

  const result = db.prepare(`
    UPDATE ride_requests
    SET
      status='new',
      assigned_driver_id=NULL,
      accepted_at=NULL,
      admin_approved_at=NULL
    WHERE id=?
      AND customer_id=?
      AND status='cancelled'
  `).run(id, req.user.id);

  if (!result.changes) {
    return res.status(409).json({
      error: 'Nur eigene stornierte Anfragen können erneut eingereicht werden.'
    });
  }

  res.json({
    message: 'Anfrage erneut eingereicht und wartet auf Freigabe.'
  });
});


/* =========================================================
   REQUEST PHOTOS
========================================================= */

app.get('/api/rides/:id/photos', roles('customer', 'driver', 'admin'), (req, res) => {
  const id = Number(req.params.id);

  const ride = db.prepare(
    'SELECT * FROM ride_requests WHERE id=?'
  ).get(id);

  if (!ride) {
    return res.status(404).json({
      error: 'Anfrage nicht gefunden.'
    });
  }

  const allowed =
    req.user.role === 'admin' ||
    (
      req.user.role === 'customer' &&
      ride.customer_id === req.user.id
    ) ||
    (
      req.user.role === 'driver' &&
      (
        (ride.status === 'quoted' && !ride.assigned_driver_id) ||
        (
          ride.status === 'accepted' &&
          ride.assigned_driver_id === req.user.id
        )
      )
    );

  if (!allowed) {
    return res.status(403).json({
      error: 'Keine Berechtigung.'
    });
  }

  let photos = [];

  try {
    photos = ride.photos_json
      ? JSON.parse(ride.photos_json)
      : [];
  } catch (_) {}

  res.json({
    photos
  });
});


/* =========================================================
   PRIVATE CHAT
   Only customer + accepted provider can use it.
========================================================= */

function chatRide(id) {
  return db.prepare(`
    SELECT id,customer_id,assigned_driver_id,status
    FROM ride_requests
    WHERE id=?
  `).get(id);
}


function chatAllowed(ride, user) {
  return !!ride &&
    ride.status === 'accepted' &&
    ride.assigned_driver_id != null &&
    (
      (
        user.role === 'customer' &&
        ride.customer_id === user.id
      ) ||
      (
        user.role === 'driver' &&
        ride.assigned_driver_id === user.id
      )
    );
}


app.get('/api/rides/:id/messages', roles('customer', 'driver'), (req, res) => {
  const id = Number(req.params.id);
  const ride = chatRide(id);

  if (!ride) {
    return res.status(404).json({
      error: 'Anfrage nicht gefunden.'
    });
  }

  if (!chatAllowed(ride, req.user)) {
    return res.status(403).json({
      error: 'Der private Chat wird erst nach Admin-Freigabe und Annahme durch den Dienstleister geöffnet.'
    });
  }

  const messages = db.prepare(`
    SELECT
      m.id,
      m.sender_id,
      m.message,
      m.created_at,
      u.name AS sender_name
    FROM chat_messages m
    JOIN users u ON u.id=m.sender_id
    WHERE m.ride_request_id=?
    ORDER BY m.id DESC
    LIMIT 200
  `).all(id).reverse();

  res.json({
    messages
  });
});


app.post('/api/rides/:id/messages', roles('customer', 'driver'), (req, res) => {
  const id = Number(req.params.id);
  const ride = chatRide(id);

  if (!ride) {
    return res.status(404).json({
      error: 'Anfrage nicht gefunden.'
    });
  }

  if (!chatAllowed(ride, req.user)) {
    return res.status(403).json({
      error: 'Der private Chat wird erst nach Admin-Freigabe und Annahme durch den Dienstleister geöffnet.'
    });
  }

  const message = text(req.body.message, 2000);

  if (!message) {
    return res.status(400).json({
      error: 'Bitte gib eine Nachricht mit 1 bis 2000 Zeichen ein.'
    });
  }

  const savedId = Number(
    db.prepare(`
      INSERT INTO chat_messages(ride_request_id,sender_id,message)
      VALUES(?,?,?)
    `).run(id, req.user.id, message).lastInsertRowid
  );

  const recipient =
    req.user.role === 'customer'
      ? ride.assigned_driver_id
      : ride.customer_id;

  db.prepare(`
    INSERT INTO chat_notifications(
      recipient_id,
      ride_request_id,
      message_id
    )
    VALUES(?,?,?)
  `).run(recipient, id, savedId);

  const saved = db.prepare(`
    SELECT
      m.id,
      m.sender_id,
      m.message,
      m.created_at,
      u.name AS sender_name
    FROM chat_messages m
    JOIN users u ON u.id=m.sender_id
    WHERE m.id=?
  `).get(savedId);

  res.status(201).json({
    message: saved
  });
});


/* =========================================================
   CHAT NOTIFICATIONS
========================================================= */

app.get('/api/notifications/unread', roles('customer', 'driver'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      n.id,
      n.ride_request_id,
      n.message_id,
      n.created_at,
      m.message,
      u.name AS sender_name
    FROM chat_notifications n
    JOIN chat_messages m ON m.id=n.message_id
    JOIN users u ON u.id=m.sender_id
    WHERE n.recipient_id=?
      AND n.read_at IS NULL
    ORDER BY n.id DESC
    LIMIT 50
  `).all(req.user.id);

  res.json({
    notifications: rows
  });
});


app.post('/api/notifications/read', roles('customer', 'driver'), (req, res) => {
  const ids = Array.isArray(req.body.ids)
    ? [...new Set(
        req.body.ids
          .map(Number)
          .filter(x => Number.isSafeInteger(x) && x > 0)
      )].slice(0, 100)
    : [];

  if (ids.length) {
    const marks = ids.map(() => '?').join(',');

    db.prepare(`
      UPDATE chat_notifications
      SET read_at=CURRENT_TIMESTAMP
      WHERE recipient_id=?
        AND id IN (${marks})
    `).run(req.user.id, ...ids);
  }

  res.json({
    ok: true
  });
});


/* =========================================================
   ADMIN SUMMARY
========================================================= */

app.get('/api/admin/summary', roles('admin'), (req, res) => {
  res.json({
    users: db.prepare(
      'SELECT COUNT(*) AS n FROM users'
    ).get().n,

    drivers: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role='driver'"
    ).get().n,

    customers: db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role='customer'"
    ).get().n,

    rides: db.prepare(
      'SELECT COUNT(*) AS n FROM ride_requests'
    ).get().n,

    newRides: db.prepare(
      "SELECT COUNT(*) AS n FROM ride_requests WHERE status='new'"
    ).get().n,

    availableRides: db.prepare(
      "SELECT COUNT(*) AS n FROM ride_requests WHERE status='quoted' AND assigned_driver_id IS NULL"
    ).get().n
  });
});


/* =========================================================
   ADMIN USERS
========================================================= */

app.get('/api/admin/users', roles('admin'), (req, res) => {
  const users = db.prepare(`
    SELECT id,name,email,role,active,created_at
    FROM users
    ORDER BY id DESC
    LIMIT 500
  `).all().map(publicUser);

  res.json({
    users
  });
});


app.patch('/api/admin/users/:id', roles('admin'), (req, res) => {
  const id = Number(req.params.id);
  const active = req.body.active;

  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    typeof active !== 'boolean'
  ) {
    return res.status(400).json({
      error: 'Ungültige Daten.'
    });
  }

  const target = db.prepare(
    'SELECT id,role FROM users WHERE id=?'
  ).get(id);

  if (!target) {
    return res.status(404).json({
      error: 'Nutzer nicht gefunden.'
    });
  }

  if (target.role === 'admin') {
    return res.status(400).json({
      error: 'Administratorkonten können hier nicht geändert werden.'
    });
  }

  db.prepare(
    'UPDATE users SET active=? WHERE id=?'
  ).run(active ? 1 : 0, id);

  if (!active && target.role === 'driver') {
    db.prepare(`
      UPDATE ride_requests
      SET
        status='quoted',
        assigned_driver_id=NULL,
        accepted_at=NULL
      WHERE status='accepted'
        AND assigned_driver_id=?
    `).run(id);
  }

  res.json({
    message: active
      ? 'Dienstleisterkonto freigeschaltet.'
      : 'Konto deaktiviert.'
  });
});


/* =========================================================
   ADMIN REQUESTS
========================================================= */

app.get('/api/admin/rides', roles('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      r.*,
      c.name AS customer_name,
      c.email AS customer_email,
      d.name AS driver_name
    FROM ride_requests r
    JOIN users c ON c.id=r.customer_id
    LEFT JOIN users d ON d.id=r.assigned_driver_id
    ORDER BY r.id DESC
    LIMIT 500
  `).all();

  res.json({
    rides: rows.map(rideView)
  });
});


app.patch('/api/admin/rides/:id', roles('admin'), (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;

  if (
    !Number.isSafeInteger(id) ||
    id < 1 ||
    !['new', 'quoted', 'cancelled', 'completed'].includes(status)
  ) {
    return res.status(400).json({
      error: 'Ungültiger Status.'
    });
  }

  const ride = db.prepare(
    'SELECT * FROM ride_requests WHERE id=?'
  ).get(id);

  if (!ride) {
    return res.status(404).json({
      error: 'Anfrage nicht gefunden.'
    });
  }

  if (
    status === 'quoted' &&
    (!Number.isInteger(ride.price_cents) || ride.price_cents < 100)
  ) {
    return res.status(400).json({
      error: 'Für diese Anfrage ist kein gültiger Festpreis gespeichert.'
    });
  }

  if (status === 'quoted' && ride.status === 'accepted') {
    return res.status(409).json({
      error: 'Ein angenommener Auftrag muss zuerst vom Dienstleister freigegeben werden.'
    });
  }

  const approved =
    status === 'quoted'
      ? (ride.admin_approved_at || new Date().toISOString())
      : ride.admin_approved_at;

  db.prepare(`
    UPDATE ride_requests
    SET
      status=?,
      admin_approved_at=?,

      assigned_driver_id=
        CASE
          WHEN ? IN ('new','cancelled','completed')
          THEN NULL
          ELSE assigned_driver_id
        END,

      accepted_at=
        CASE
          WHEN ? IN ('new','cancelled','completed')
          THEN NULL
          ELSE accepted_at
        END

    WHERE id=?
  `).run(
    status,
    approved,
    status,
    status,
    id
  );

  res.json({
    message:
      status === 'quoted'
        ? 'Anfrage freigegeben und für Dienstleister sichtbar.'
        : status === 'cancelled'
          ? 'Anfrage storniert.'
          : status === 'completed'
            ? 'Anfrage abgeschlossen.'
            : 'Status zurückgesetzt.'
  });
});


/* =========================================================
   ADMIN SETTINGS
========================================================= */

app.get('/api/admin/settings', roles('admin'), (req, res) => {
  const rows = db.prepare(
    'SELECT key,value FROM settings'
  ).all();

  const settings = Object.fromEntries(
    rows.map(x => [x.key, x.value])
  );

  res.json({
    settings: {
      site_name: settings.site_name || 'HelferFix',
      platform_fee_percent: settings.platform_fee_percent || '10',
      support_email: settings.support_email || ''
    }
  });
});


app.put('/api/admin/settings', roles('admin'), (req, res) => {
  const site = text(req.body.site_name, 80);
  const email = text(req.body.support_email, 254);
  const fee = Number(req.body.platform_fee_percent);

  if (
    !site ||
    !Number.isFinite(fee) ||
    fee < 0 ||
    fee > 30 ||
    (email && !emailValid(email))
  ) {
    return res.status(400).json({
      error: 'Bitte prüfe Name, Support-E-Mail und Provision (0–30 %).'
    });
  }

  const save = db.transaction(() => {
    for (const [key, value] of Object.entries({
      site_name: site,
      platform_fee_percent: String(fee),
      support_email: email
    })) {
      db.prepare(`
        INSERT INTO settings(key,value,updated_at)
        VALUES(?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(key)
        DO UPDATE SET
          value=excluded.value,
          updated_at=CURRENT_TIMESTAMP
      `).run(key, value);
    }
  });

  save();

  res.json({
    message: 'Einstellungen gespeichert. Die Provision wird berechnet, aber nicht automatisch eingezogen.'
  });
});


/* =========================================================
   ERROR HANDLING AND STARTUP
========================================================= */

app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API-Endpunkt nicht gefunden.'
  });
});

app.get('*', (req, res) => {
  res.sendFile(
    path.join(__dirname, 'public', 'index.html')
  );
});

app.use((err, req, res, next) => {
  console.error('HelferFix request error:', err);

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    error: 'Interner Fehler.'
  });
});


ensureAdmin()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `HelferFix listening on port ${PORT}; database: ${DB_FILE}`
      );
    });
  })
  .catch(err => {
    console.error('HelferFix startup failed:', err);
    process.exit(1);
  });
