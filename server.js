function normalizeTime(str) {
  if (!str) return '';
  const m = String(str).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return '';
  const h = m[1].padStart(2, '0');
  const min = m[2];
  const s = m[3] || '00';
  return `${h}:${min}:${s}`;
}
// server.js
//
// Backend Check In / Out + Admin
//

const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');
const basicAuth = require('express-basic-auth');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// === CONFIG GOOGLE SHEETS ===================================================

// ID de TON Google Sheet
const SPREADSHEET_ID = '1a41o2i9j2wlesilXL3myTCwuBhUEhtzapoe16JcG4nQ';
const RAW_SHEET_NAME = 'Logs';       // onglet brut avec Horodatage / Type / etc
const CLEAN_SHEET_NAME = 'logs_clean'; // onglet consolidé

// Clé de service dans une variable d'env (copie du JSON complet)
const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (!serviceAccountKey) {
  console.error('❌ GOOGLE_SERVICE_ACCOUNT_KEY manquante');
}

let googleAuth = null;

async function getSheetsClient() {
  if (!googleAuth) {
    googleAuth = new google.auth.GoogleAuth({
      credentials: JSON.parse(serviceAccountKey),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  const authClient = await googleAuth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

// === HELPERS TEMPS ==========================================================

function timeStringToHours(str) {
  if (!str) return 0;
  const parts = String(str).split(':');
  if (parts.length < 2) return 0;
  const h = parseInt(parts[0], 10) || 0;
  const m = parseInt(parts[1], 10) || 0;
  const s = parseInt(parts[2] || '0', 10) || 0;
  return h + m / 60 + s / 3600;
}

// === MIDDLEWARES ============================================================

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); // sert index.html

// === ROUTE API PUBLIC : /api/check =========================================
//
// Ajoute une ligne dans l’onglet Logs :
// A: Horodatage (ISO) | B: Type | C: Utilisateur | D: Jour | E: Heure
// F: Heures_travaillé (laissé vide, calculé par formules) | G,H: lat/lng
//
app.post('/api/check', async (req, res) => {
  try {
    const { type, userName, latitude, longitude } = req.body;

    if (!type || !['IN', 'OUT'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type invalide (IN / OUT)' });
    }

    if (!userName || userName.trim() === '') {
      return res.status(400).json({ success: false, message: 'Nom utilisateur obligatoire' });
    }

    const now = new Date();
    const horodatage = now.toISOString();

    const jour = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const heure = now.toTimeString().slice(0, 8); // HH:MM:SS

    const lat = latitude ?? '';
    const lng = longitude ?? '';

    const sheets = await getSheetsClient();

    const range = `${RAW_SHEET_NAME}!A:H`;

    const values = [[
      horodatage, // A
      type,       // B
      userName,   // C
      jour,       // D
      heure,      // E
      '',         // F Heures_travaillé (laissé vide, formule dans Sheet)
      lat,        // G
      lng         // H
    ]];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values },
    });

    return res.json({ success: true, message: 'Pointage enregistré avec succès.' });
  } catch (err) {
    console.error('Erreur API /api/check :', err);
    return res.status(500).json({
      success: false,
      message: err.message || 'Erreur serveur lors de l’enregistrement.',
    });
  }
});

// === ADMIN AUTH =============================================================

const adminUser = process.env.ADMIN_USER || 'admin';
const adminPass = process.env.ADMIN_PASS || 'changeme';

app.use(
  '/admin',
  basicAuth({
    users: { [adminUser]: adminPass },
    challenge: true,
  })
);

// === PAGE ADMIN (HTML) ======================================================

app.get('/admin', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>Admin – Check In / Out</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; background:#f5f5f5; }
    h1, h2 { margin-top: 16px; }
    .section { background:#fff; border-radius:16px; padding:16px 20px; margin-bottom:16px; box-shadow:0 4px 12px rgba(0,0,0,0.06); }
    label { font-size:14px; margin-right:8px; }
    input, select { padding:6px 8px; border-radius:8px; border:1px solid #ccc; margin-right:8px; margin-bottom:6px; }
    button { padding:8px 14px; border-radius:999px; border:none; background:#1976d2; color:#fff; cursor:pointer; font-size:14px; }
    button.danger { background:#e53935; }
    table { border-collapse: collapse; width: 100%; font-size:13px; }
    th, td { border-bottom:1px solid #eee; padding:4px 6px; text-align:left; }
    th { background:#fafafa; position:sticky; top:0; z-index:1; }
    .small { font-size:12px; color:#666; }
    .flex { display:flex; flex-wrap:wrap; align-items:center; }
    .mt8 { margin-top:8px; }
    canvas { max-width:100%; }
    .tag { display:inline-block; padding:2px 6px; border-radius:999px; background:#eee; font-size:11px; margin-left:4px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>

  <h1>Admin – Check In / Out</h1>

  <!-- DASHBOARD -->
  <div class="section">
    <h2>1. Dashboard</h2>
    <div class="flex">
      <label>Année :</label>
      <input id="dashYear" type="number" value="${new Date().getFullYear()}" />
      <button onclick="loadDashboard()">Actualiser</button>
    </div>
    <p class="small">Graphique des heures totales et heures sup par mois.</p>
    <canvas id="dashChart" height="120"></canvas>
    <div class="mt8">
      <table id="dashTable">
        <thead>
          <tr>
            <th>Utilisateur</th>
            <th>Année</th>
            <th>Mois</th>
            <th>Total heures</th>
            <th>Total heures sup</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- EDITION DES POINTAGES -->
  <div class="section">
    <h2>2. Gestion des pointages</h2>
    <div class="flex">
      <label>Année :</label>
      <input id="logsYear" type="number" value="${new Date().getFullYear()}" />
      <label>Mois :</label>
      <input id="logsMonth" type="number" min="1" max="12" value="${new Date().getMonth() + 1}" />
      <button onclick="loadLogs()">Charger les lignes</button>
    </div>
    <p class="small">Modifier ou supprimer les lignes de l'onglet Logs (brut).</p>
    <div style="max-height:320px; overflow:auto; margin-top:8px;">
      <table id="logsTable">
        <thead>
          <tr>
            <th>#</th>
            <th>Date (Jour)</th>
            <th>Type</th>
            <th>Utilisateur</th>
            <th>Heure</th>
            <th>Latitude</th>
            <th>Longitude</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- ENVOI EMAIL PDF -->
  <div class="section">
    <h2>3. Envoi du rapport mensuel par email</h2>
    <div class="flex">
      <label>Année :</label>
      <input id="mailYear" type="number" value="${new Date().getFullYear()}" />
      <label>Mois :</label>
      <input id="mailMonth" type="number" min="1" max="12" value="${new Date().getMonth() + 1}" />
    </div>
    <div class="flex mt8">
      <label>Destinataire :</label>
      <input id="mailTo" type="email" placeholder="compta@exemple.com" style="min-width:260px;" />
      <button onclick="sendReport()">Générer & envoyer le PDF</button>
    </div>
    <p id="mailStatus" class="small"></p>
  </div>

<script>
let dashChart = null;

// === DASHBOARD ==============================================================
async function loadDashboard() {
  const year = document.getElementById('dashYear').value;
  const res = await fetch('/admin/api/dashboard?year=' + encodeURIComponent(year));
  const data = await res.json();

  const tbody = document.querySelector('#dashTable tbody');
  tbody.innerHTML = '';

  const labels = [];
  const totalHours = [];
  const totalOver = [];

  data.rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + row.user + '</td>' +
                   '<td>' + row.year + '</td>' +
                   '<td>' + row.month + '</td>' +
                   '<td>' + row.totalHours.toFixed(2) + '</td>' +
                   '<td>' + row.totalOvertime.toFixed(2) + '</td>';
    tbody.appendChild(tr);

    labels.push(row.year + '-' + String(row.month).padStart(2, '0') + ' (' + row.user + ')');
    totalHours.push(row.totalHours);
    totalOver.push(row.totalOvertime);
  });

  const ctx = document.getElementById('dashChart').getContext('2d');
  if (dashChart) dashChart.destroy();
  dashChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Total heures',
          data: totalHours
        },
        {
          label: 'Total heures sup',
          data: totalOver
        }
      ]
    },
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Heures' }
        }
      }
    }
  });
}

// === LOGS (EDITION) =========================================================
async function loadLogs() {
  const year = document.getElementById('logsYear').value;
  const month = document.getElementById('logsMonth').value;
  const res = await fetch('/admin/api/logs?year=' + year + '&month=' + month);
  const data = await res.json();

  const tbody = document.querySelector('#logsTable tbody');
  tbody.innerHTML = '';

  data.rows.forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + row.rowIndex + '</td>' +
      '<td><input type="date" value="' + (row.jour || '') + '" data-field="jour"></td>' +
      '<td><select data-field="type">' +
        '<option value="IN"' + (row.type === 'IN' ? ' selected' : '') + '>IN</option>' +
        '<option value="OUT"' + (row.type === 'OUT' ? ' selected' : '') + '>OUT</option>' +
      '</select></td>' +
      '<td><input type="text" value="' + (row.user || '') + '" data-field="user"></td>' +
      '<td><input type="time" step="1" value="' + (row.heure || '') + '" data-field="heure"></td>' +
      '<td><input type="text" value="' + (row.lat || '') + '" data-field="lat"></td>' +
      '<td><input type="text" value="' + (row.lng || '') + '" data-field="lng"></td>' +
      '<td>' +
        '<button onclick="saveRow(' + row.rowIndex + ', this)">Sauver</button> ' +
        '<button class="danger" onclick="deleteRow(' + row.rowIndex + ')">Supprimer</button>' +
      '</td>';
    tbody.appendChild(tr);
  });
}

async function saveRow(rowIndex, btn) {
  const tr = btn.closest('tr');
  const get = (name) => tr.querySelector('[data-field="' + name + '"]').value;

  const payload = {
    rowIndex,
    jour: get('jour'),
    type: get('type'),
    user: get('user'),
    heure: get('heure'),
    lat: get('lat'),
    lng: get('lng')
  };

  const res = await fetch('/admin/api/logs/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  alert(data.message || (data.success ? 'Sauvegardé' : 'Erreur sauvegarde'));
}

async function deleteRow(rowIndex) {
  if (!confirm('Supprimer la ligne ' + rowIndex + ' ?')) return;

  const res = await fetch('/admin/api/logs/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rowIndex })
  });

  const data = await res.json();
  alert(data.message || (data.success ? 'Supprimé' : 'Erreur suppression'));
  if (data.success) {
    loadLogs();
  }
}

// === ENVOI PDF PAR EMAIL ====================================================
async function sendReport() {
  const year = document.getElementById('mailYear').value;
  const month = document.getElementById('mailMonth').value;
  const to = document.getElementById('mailTo').value;
  const statusEl = document.getElementById('mailStatus');

  if (!to) {
    statusEl.textContent = 'Merci de saisir une adresse email.';
    return;
  }

  statusEl.textContent = 'Envoi en cours...';

  const res = await fetch('/admin/api/send-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year, month, to })
  });

  const data = await res.json();
  statusEl.textContent = data.message || (data.success ? 'Rapport envoyé.' : 'Erreur envoi rapport.');
}

// Chargement auto du dashboard à l’ouverture
window.addEventListener('load', loadDashboard);
</script>

</body>
</html>
  `);
});

// === ADMIN API : LISTE DES LOGS POUR EDITION ================================

app.get('/admin/api/logs', async (req, res) => {
  try {
    const yearFilter = String(req.query.year || '');
    const monthFilter = String(req.query.month || '');
    const sheets = await getSheetsClient();

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RAW_SHEET_NAME}!A2:K`,
    });

    const rows = result.data.values || [];
    const formatted = [];

    let rowIndex = 2; // index réel dans la feuille
    for (const r of rows) {
      const jour = r[3] || ''; // col D = Jour (YYYY-MM-DD)
      let annee = '';
      let mois = '';

      if (jour) {
        const d = new Date(jour);
        if (!isNaN(d.getTime())) {
          annee = String(d.getFullYear());
          mois = String(d.getMonth() + 1); // 1-12
        }
      }

      if (yearFilter && annee && annee !== yearFilter) { rowIndex++; continue; }
      if (monthFilter && mois && mois !== monthFilter) { rowIndex++; continue; }

      // si pas de date valide, on ignore
      if (!jour) { rowIndex++; continue; }

      formatted.push({
        rowIndex,
        horodatage: r[0] || '',
        type: r[1] || '',
        user: r[2] || '',
        jour,
        heure: normalizeTime(r[4] || ''),
        lat: r[6] || '',
        lng: r[7] || ''
      });

      rowIndex++;
    }

    res.json({ success: true, rows: formatted });
  } catch (err) {
    console.error('Erreur /admin/api/logs :', err);
    res.status(500).json({ success: false, message: 'Erreur lecture logs' });
  }
});


// === ADMIN API : LISTE DES LOGS POUR EDITION ================================

app.get('/admin/api/logs', async (req, res) => {
  try {
    const year = String(req.query.year || '');
    const month = String(req.query.month || '');
    const sheets = await getSheetsClient();

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${RAW_SHEET_NAME}!A2:K`,
    });

    const rows = result.data.values || [];
    const formatted = [];

    // Index de ligne réel dans la feuille (on commence à 2)
    let rowIndex = 2;
    for (const r of rows) {
      const annee = r[9] || '';   // col J
      const mois = r[10] || '';   // col K

      if (year && annee !== year) { rowIndex++; continue; }
      if (month && mois !== month) { rowIndex++; continue; }

      formatted.push({
        rowIndex,
        horodatage: r[0] || '',
        type: r[1] || '',
        user: r[2] || '',
        jour: r[3] || '',
        heure: r[4] || '',
        lat: r[6] || '',
        lng: r[7] || ''
      });

      rowIndex++;
    }

    res.json({ success: true, rows: formatted });
  } catch (err) {
    console.error('Erreur /admin/api/logs :', err);
    res.status(500).json({ success: false, message: 'Erreur lecture logs' });
  }
});

// === ADMIN API : UPDATE LOG ROW ============================================

app.post('/admin/api/logs/update', async (req, res) => {
  try {
    const { rowIndex, jour, type, user, heure, lat, lng } = req.body;

    if (!rowIndex) {
      return res.status(400).json({ success: false, message: 'rowIndex manquant' });
    }

    const sheets = await getSheetsClient();

    // Horodatage recomposé à partir de jour + heure
    let horodatage = '';
    if (jour && heure) {
      horodatage = `${jour} ${heure}`;
    }

    // Mise à jour A:E
    const rangeMain = `${RAW_SHEET_NAME}!A${rowIndex}:E${rowIndex}`;
    const valuesMain = [[
      horodatage || '',       // A
      type || '',             // B
      user || '',             // C
      jour || '',             // D
      heure || ''             // E
    ]];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: rangeMain,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: valuesMain },
    });

    // Mise à jour lat/lng (G:H)
    const rangeGeo = `${RAW_SHEET_NAME}!G${rowIndex}:H${rowIndex}`;
    const valuesGeo = [[lat || '', lng || '']];

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: rangeGeo,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: valuesGeo },
    });

    res.json({ success: true, message: 'Ligne mise à jour.' });
  } catch (err) {
    console.error('Erreur /admin/api/logs/update :', err);
    res.status(500).json({ success: false, message: 'Erreur mise à jour' });
  }
});

// === ADMIN API : DELETE LOG ROW ============================================

app.post('/admin/api/logs/delete', async (req, res) => {
  try {
    const { rowIndex } = req.body;
    if (!rowIndex) {
      return res.status(400).json({ success: false, message: 'rowIndex manquant' });
    }

    const sheets = await getSheetsClient();

    // On efface toute la ligne A:K
    const range = `${RAW_SHEET_NAME}!A${rowIndex}:K${rowIndex}`;
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });

    res.json({ success: true, message: 'Ligne supprimée.' });
  } catch (err) {
    console.error('Erreur /admin/api/logs/delete :', err);
    res.status(500).json({ success: false, message: 'Erreur suppression' });
  }
});

// === ADMIN API : ENVOI PDF PAR EMAIL =======================================

async function getMonthlyRows(year, month) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${CLEAN_SHEET_NAME}!A2:K`,
  });

  const rows = res.data.values || [];
  const yr = String(year);
  const mo = String(month);

  return rows.filter((r) => r[2] === yr && r[3] === mo);
}

app.post('/admin/api/send-report', async (req, res) => {
  try {
    const { year, month, to } = req.body;

    if (!to) {
      return res.status(400).json({ success: false, message: 'Email destinataire manquant' });
    }

    const data = await getMonthlyRows(year, month);

    // Création du PDF en mémoire
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    const pdfPromise = new Promise((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });

    doc.fontSize(18).text(`Rapport mensuel – ${month}/${year}`, { underline: true });
    doc.moveDown();

    if (!data.length) {
      doc.fontSize(12).text('Aucune donnée pour ce mois.');
    } else {
      doc.fontSize(12).text('Date – Utilisateur – IN → OUT – Heures travaillées');
      doc.moveDown(0.5);

      data.forEach((row) => {
        const [user, jour, annee, mois, hin, hout, htrav] = [
          row[0] || '',
          row[1] || '',
          row[2] || '',
          row[3] || '',
          row[4] || '',
          row[5] || '',
          row[6] || '',
        ];
        doc.fontSize(10).text(
          `${jour} – ${user} : ${hin || '-'} → ${hout || '-'} (${htrav || '-'})`
        );
      });
    }

    doc.end();
    const pdfBuffer = await pdfPromise;

    // Config SMTP
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject: `Rapport heures – ${month}/${year}`,
      text: 'Veuillez trouver ci-joint le rapport des heures.',
      attachments: [
        {
          filename: `rapport-${year}-${month}.pdf`,
          content: pdfBuffer,
        },
      ],
    });

    res.json({ success: true, message: 'Rapport envoyé.' });
  } catch (err) {
    console.error('Erreur /admin/api/send-report :', err);
    res.status(500).json({ success: false, message: 'Erreur envoi email' });
  }
});

// === DEMARRAGE SERVEUR ======================================================

app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
