require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const { schemaReady, seedAdmin } = require('./db');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3002',
  credentials: true,
}));
app.use(cookieParser());
app.use(express.json({ limit: '2mb' }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',        require('./routes/auth'));
app.use('/api/branches',    require('./routes/branches'));
app.use('/api/users',       require('./routes/users'));
app.use('/api/staff',       require('./routes/staff'));
app.use('/api/shift-types', require('./routes/shift_types'));
app.use('/api/schedules',   require('./routes/schedules'));
app.use('/api/leaves',      require('./routes/leaves'));
app.use('/api/generate',    require('./routes/generate'));
app.use('/api/audit',       require('./routes/audit'));

// ── Serve dashboard ───────────────────────────────────────────────────────────
const DASHBOARD = path.join(__dirname, '..', 'dashboard');
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  express.static(DASHBOARD)(req, res, next);
});
app.get('/{*path}', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DASHBOARD, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({ error: process.env.NODE_ENV !== 'production' ? err.message : 'Server error' });
});

const PORT = process.env.PORT || 3002;

schemaReady
  .then(() => seedAdmin())
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🏥 Meena Scheduling running at http://localhost:${PORT}\n`);
    });
  })
  .catch(err => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
