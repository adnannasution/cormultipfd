const express = require('express');
const { Pool }  = require('pg');
const cors      = require('cors');
const path      = require('path');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB init + migration ───────────────────────────────────────────────────
async function initDB() {
  // Create tables with unit column
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conditions (
      unit             TEXT NOT NULL DEFAULT 'cdu11',
      tag              TEXT NOT NULL,
      type             TEXT,
      status           TEXT DEFAULT 'Normal',
      visual_level     TEXT,
      visual_notes     TEXT,
      corrosion_level  TEXT,
      corrosion_rate   NUMERIC(10,4) DEFAULT 0,
      thickness        NUMERIC(10,2) DEFAULT 0,
      rl_value         NUMERIC(10,2) DEFAULT 0,
      rl_level         TEXT,
      updated_at       TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (unit, tag)
    );
    CREATE TABLE IF NOT EXISTS tags (
      unit       TEXT NOT NULL DEFAULT 'cdu11',
      uid        TEXT NOT NULL,
      tag        TEXT NOT NULL,
      type       TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (unit, uid)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pfds (
      unit        TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      svg_content TEXT,
      uploaded_at TIMESTAMPTZ DEFAULT NOW(),
      uploaded_by TEXT
    );
  `);

  // ── Safe migration: add unit column if old single-unit tables exist ──
  // conditions: add unit column if missing
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='conditions' AND column_name='tag'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='conditions' AND column_name='unit'
        )
      ) THEN
        ALTER TABLE conditions ADD COLUMN unit TEXT NOT NULL DEFAULT 'cdu11';
        -- Drop old PK, add composite PK
        ALTER TABLE conditions DROP CONSTRAINT IF EXISTS conditions_pkey;
        ALTER TABLE conditions ADD PRIMARY KEY (unit, tag);
      END IF;
    END $$;
  `).catch(() => {}); // ignore if already done

  // tags: add unit column if missing
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name='tags' AND column_name='uid'
        AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='tags' AND column_name='unit'
        )
      ) THEN
        ALTER TABLE tags ADD COLUMN unit TEXT NOT NULL DEFAULT 'cdu11';
        ALTER TABLE tags DROP CONSTRAINT IF EXISTS tags_pkey;
        ALTER TABLE tags ADD PRIMARY KEY (unit, uid);
      END IF;
    END $$;
  `).catch(() => {});

  console.log('✅ DB ready (multi-unit)');
}

// ── CONDITIONS ─────────────────────────────────────────────────────────────
app.get('/api/conditions', async (req, res) => {
  try {
    const unit = req.query.unit || 'cdu11';
    const result = await pool.query(
      'SELECT * FROM conditions WHERE unit=$1 ORDER BY tag ASC', [unit]
    );
    const cond = {};
    result.rows.forEach(row => { cond[row.tag] = row; });
    res.json(cond);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/conditions', async (req, res) => {
  try {
    const { unit='cdu11', tag, type, status, visual_level, visual_notes,
            corrosion_level, corrosion_rate, thickness, rl_value, rl_level } = req.body;
    if (!tag) return res.status(400).json({ error: 'tag is required' });
    const result = await pool.query(`
      INSERT INTO conditions
        (unit, tag, type, status, visual_level, visual_notes,
         corrosion_level, corrosion_rate, thickness, rl_value, rl_level, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (unit, tag) DO UPDATE SET
        type=EXCLUDED.type, status=EXCLUDED.status,
        visual_level=EXCLUDED.visual_level, visual_notes=EXCLUDED.visual_notes,
        corrosion_level=EXCLUDED.corrosion_level, corrosion_rate=EXCLUDED.corrosion_rate,
        thickness=EXCLUDED.thickness, rl_value=EXCLUDED.rl_value,
        rl_level=EXCLUDED.rl_level, updated_at=NOW()
      RETURNING *
    `, [unit, tag, type||null, status||'Normal', visual_level||null, visual_notes||null,
        corrosion_level||null, parseFloat(corrosion_rate)||0,
        parseFloat(thickness)||0, parseFloat(rl_value)||0, rl_level||null]);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.delete('/api/conditions/:unit/:tag', async (req, res) => {
  try {
    await pool.query('DELETE FROM conditions WHERE unit=$1 AND tag=$2',
      [req.params.unit, req.params.tag]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── COLOR SCALES (shared across all units) ────────────────────────────────
app.get('/api/scales', async (req, res) => {
  try {
    const result = await pool.query("SELECT value FROM settings WHERE key='color_scales'");
    if (!result.rows.length) return res.json(null);
    res.json(JSON.parse(result.rows[0].value));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/scales', async (req, res) => {
  try {
    const { scales } = req.body;
    if (!scales) return res.status(400).json({ error: 'scales required' });
    await pool.query(`
      INSERT INTO settings (key, value, updated_at) VALUES ('color_scales', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
    `, [JSON.stringify(scales)]);
    res.json({ saved: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── TAGS ───────────────────────────────────────────────────────────────────
app.get('/api/tags', async (req, res) => {
  try {
    const unit = req.query.unit || 'cdu11';
    const result = await pool.query(
      'SELECT * FROM tags WHERE unit=$1 ORDER BY uid ASC', [unit]
    );
    const tags = {};
    result.rows.forEach(row => { tags[row.uid] = row; });
    res.json(tags);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tags', async (req, res) => {
  try {
    const { unit='cdu11', uid, tag, type } = req.body;
    if (!uid || !tag) return res.status(400).json({ error: 'uid and tag required' });
    const result = await pool.query(`
      INSERT INTO tags (unit, uid, tag, type, updated_at) VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (unit, uid) DO UPDATE SET tag=EXCLUDED.tag, type=EXCLUDED.type, updated_at=NOW()
      RETURNING *
    `, [unit, uid, tag, type||null]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/tags/:unit/:uid', async (req, res) => {
  try {
    await pool.query('DELETE FROM tags WHERE unit=$1 AND uid=$2',
      [req.params.unit, req.params.uid]);
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk upsert — batches of 50
app.post('/api/tags/bulk', async (req, res) => {
  try {
    const { unit='cdu11', tags } = req.body;
    if (!Array.isArray(tags) || !tags.length) return res.status(400).json({ error: 'tags array required' });
    const BATCH_SIZE = 50;
    let saved = 0;
    for (let i = 0; i < tags.length; i += BATCH_SIZE) {
      const batch = tags.slice(i, i + BATCH_SIZE);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const { uid, tag, type } of batch) {
          await client.query(`
            INSERT INTO tags (unit, uid, tag, type, updated_at) VALUES ($1,$2,$3,$4,NOW())
            ON CONFLICT (unit, uid) DO UPDATE SET tag=EXCLUDED.tag, type=EXCLUDED.type, updated_at=NOW()
          `, [unit, uid, tag||'', type||null]);
        }
        await client.query('COMMIT');
        saved += batch.length;
      } catch(e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    }
    res.json({ saved });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// ── Units list (for dashboard) ─────────────────────────────────────────────
app.get('/api/units', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT unit, COUNT(*) as tag_count,
             MAX(updated_at) as last_updated
      FROM tags GROUP BY unit ORDER BY unit
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Summary stats per unit (for dashboard) ────────────────────────────────
app.get('/api/summary', async (req, res) => {
  try {
    const unit = req.query.unit || 'cdu11';
    const result = await pool.query(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN visual_level='Severe' OR corrosion_level='Severe' OR rl_level='Severe' THEN 1 END) as severe,
        COUNT(CASE WHEN visual_level='High' OR corrosion_level='High' OR rl_level='High' THEN 1 END) as high,
        COUNT(CASE WHEN visual_level='Moderate' OR corrosion_level='Moderate' OR rl_level='Moderate' THEN 1 END) as moderate,
        COUNT(CASE WHEN visual_level='Low' OR corrosion_level='Low' OR rl_level='Low' THEN 1 END) as low
      FROM conditions WHERE unit=$1
    `, [unit]);
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PFDs ───────────────────────────────────────────────────────────────────
// List all PFDs (without svg_content for performance)
app.get('/api/pfds', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT unit, name, uploaded_at, uploaded_by FROM pfds ORDER BY name ASC'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single PFD with SVG content
app.get('/api/pfds/:unit', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM pfds WHERE unit=$1', [req.params.unit]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'PFD not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Upload / update a PFD
app.post('/api/pfds', async (req, res) => {
  try {
    const { unit, name, svg_content, uploaded_by } = req.body;
    if (!unit || !name) return res.status(400).json({ error: 'unit and name required' });
    const result = await pool.query(`
      INSERT INTO pfds (unit, name, svg_content, uploaded_at, uploaded_by)
      VALUES ($1,$2,$3,NOW(),$4)
      ON CONFLICT (unit) DO UPDATE SET
        name=EXCLUDED.name, svg_content=EXCLUDED.svg_content,
        uploaded_at=NOW(), uploaded_by=EXCLUDED.uploaded_by
      RETURNING unit, name, uploaded_at, uploaded_by
    `, [unit, name, svg_content||null, uploaded_by||null]);
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Delete a PFD and all its tags/conditions
app.delete('/api/pfds/:unit', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM conditions WHERE unit=$1', [req.params.unit]);
    await client.query('DELETE FROM tags WHERE unit=$1', [req.params.unit]);
    await client.query('DELETE FROM pfds WHERE unit=$1', [req.params.unit]);
    await client.query('COMMIT');
    res.json({ deleted: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// ── Start ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function connectDB(retries = 5) {
  for (let i = 0; i < retries; i++) {
    try {
      await initDB();
      app.listen(PORT, () => {
        console.log(`🚀 CAIS Server running on port ${PORT}`);
      });
      return;
    }
    catch (err) {
      console.error(`DB attempt ${i+1}/${retries} failed: ${err.message}`);
      if (i < retries - 1) { console.log('Retrying in 3s...'); await new Promise(r => setTimeout(r, 3000)); }
    }
  }
  console.error('❌ DB unavailable — server not started');
}
connectDB();
