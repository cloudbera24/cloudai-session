const express = require('express');
const path = require('path');
const bodyParser = require("body-parser");
const { qrRoute, pairRoute } = require('./routes');
require('events').EventEmitter.defaultMaxListeners = 2000;

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/qr', qrRoute);
app.use('/code', pairRoute);

// Serve pages
app.get('/pair', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pair.html'));
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 200,
        success: true,
        service: 'Cloud-AI Session Generator',
        timestamp: new Date().toISOString()
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     CLOUD-AI SESSION GENERATOR                   ║
║     Running on http://localhost:${PORT}            ║
║     Format: CLOUD-AI~fileID#key                  ║
╚══════════════════════════════════════════════════╝
    `);
});

module.exports = app;