import express from 'express';
import cors from 'cors';
import { pool } from './db';

import authRouter  from './routes/auth';
import tasksRouter from './routes/tasks';
import listsRouter from './routes/lists';
import trashRouter from './routes/trash';

const app = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

const frontendUrl = process.env.FRONTEND_URL;

app.use(cors({
  origin: frontendUrl ?? '*',
  credentials: Boolean(frontendUrl),
}));

app.use(express.json());

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use('/api/auth',  authRouter);
app.use('/api/tasks', tasksRouter);
app.use('/api/lists', listsRouter);
app.use('/api/trash', trashRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function start() {
  // Verify database connectivity before accepting traffic
  try {
    await pool.query('SELECT 1');
    console.log('Database connection verified.');
  } catch (err) {
    console.error('Failed to connect to the database:', err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Solytiq Cloud API listening on port ${PORT}`);
  });
}

start();
