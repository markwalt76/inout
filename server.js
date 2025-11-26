// server.js
const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config Google Sheets ---
const SPREADSHEET_ID = '1a41o2i9j2wlesilXL3myTCwuBhUEhtzapoe16JcG4nQ'; // ton fichier

// On lit la clé JSON depuis une variable d'environnement (plus simple sur Render)
const serviceAccountKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

if (!serviceAccountKey) {
  console.error('❌ Variable d’environnement GOOGLE_SERVICE_ACCOUNT_KEY manquante.');
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

// --- Middlewares ---
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname))); // sert index.html

// --- Route API pour IN / OUT ---
app.post('/api/check', async (req, res) => {
  try {
    const { type, userName, latitude, longitude } = req.body;

    if (!type || !['IN', 'OUT'].includes(type)) {
      return res.status(400).json({ success: false, message: 'Type invalide' });
    }

    if (!userName || userName.trim() === '') {
      return res.status(400).json({ success: false, message: 'Nom utilisateur obligatoire' });
    }

    const now = new Date();

    // Horodatage complet (ISO ou format lisible)
    const horodatage = now.toISOString();

    // Jour et heure séparés
    const jour = now.toLocaleDateString('fr-FR');      // ex: 26/11/2025
    const heure = now.toLocaleTimeString('fr-FR', {    // ex: 10:32:05
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    const heuresTravaille = ''; // laissé vide, calculable plus tard dans la feuille

    const lat = latitude ?? '';
    const lng = longitude ?? '';

    const sheets = await getSheetsClient();

    const range = 'Horodatage!A:H'; // onglet "Horodatage" colonnes A -> H

    const values = [[
      horodatage,  // A - Horodatage
      type,        // B - Type (IN/OUT)
      userName,    // C - Utilisateur
      jour,        // D - Jour
      heure,       // E - Heure
      heuresTravaille, // F - Heures_travaillé (vide)
      lat,         // G - Latitude
      lng          // H - Longitude
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
      message: 'Erreur serveur lors de l’enregistrement.',
    });
  }
});

// --- Lancer le serveur ---
app.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
});
