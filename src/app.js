import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectDB } from './config/db.js';
import { checkESHealth } from './config/elasticsearch.js';
import { ensureIndexExists } from './services/elasticsearchService.js';

import catalogueRoutes from './routes/catalogueRoutes.js';
import searchRoutes from './routes/searchRoutes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — must handle OPTIONS preflight before any route so ngrok/browser
// cross-origin requests aren't blocked or returned as 404s.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  // Preflight: respond immediately with 204 No Content so the real request proceeds.
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// ─── Static dashboard ──────────────────────────────────────────────────────
app.use('/static', express.static(PUBLIC_DIR));
app.get('/dashboard', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html')));

// ─── Routes ─────────────────────────────────────────────────────────────────
app.use('/catalogue', catalogueRoutes);
app.use('/search', searchRoutes);

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const esHealthy = await checkESHealth().catch(() => false);
  res.json({
    status: 'ok',
    services: {
      elasticsearch: esHealthy ? 'connected' : 'disconnected',
    },
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 ────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` });
});

// ─── Global Error Handler ───────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Bootstrap ──────────────────────────────────────────────────────────────
const startServer = async () => {
  await connectDB();

  const esHealthy = await checkESHealth();
  if (esHealthy) {
    try {
      await ensureIndexExists();
    } catch (err) {
      console.warn('[Warning] Could not create ES index:', err.message);
    }
  } else {
    console.warn('[Warning] Elasticsearch unavailable — search endpoints will fail until ES is reachable');
  }

  app.listen(PORT, () => {
    console.log(`\n🚀 Server running at http://localhost:${PORT}\n`);
    console.log('  Endpoints:');
    console.log('  ─────────────────────────────────────────────────────');
    console.log('  POST   /catalogue/ingest               Upload CSV to ingest products');
    console.log('  GET    /catalogue/pending              View items pending review');
    console.log('  PATCH  /catalogue/pending/:id          Edit a pending item');
    console.log('  POST   /catalogue/pending/:id/approve  Approve & index in ES');
    console.log('  POST   /catalogue/pending/:id/reject   Reject a pending item');
    console.log('  POST   /search                         Image or text product search');
    console.log('  GET    /dashboard                      HTML review dashboard');
    console.log('  GET    /health                         Service health check');
    console.log('  ─────────────────────────────────────────────────────');
    console.log('\n  ⚠️  Run worker separately: node src/workers/ingestWorker.js\n');
  });
};

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
