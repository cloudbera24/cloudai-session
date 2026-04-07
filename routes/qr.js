const { generateSessionId, removeFile, ensureDir } = require('../gift');
const QRCode = require('qrcode');
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const zlib = require('zlib');
const pino = require("pino");
const { File } = require('megajs');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const router = express.Router();
const sessionDir = path.join(__dirname, '..', 'temp_sessions');

ensureDir(sessionDir);

async function uploadToMega(sessionData, sessionId) {
    try {
        const { upload } = require('megajs');
        const file = await upload(sessionData, { name: `session_${sessionId}.json` });
        const fileLink = await file.link();
        const match = fileLink.match(/\/file\/([^#]+)#(.+)/);
        
        if (match) {
            return `CLOUD-AI~${match[1]}#${match[2]}`;
        }
        return null;
    } catch (error) {
        console.error("MEGA upload error:", error);
        return null;
    }
}

router.get('/', async (req, res) => {
    const sessionId = generateSessionId(8);
    let responseSent = false;

    async function cleanUpSession() {
        await removeFile(path.join(sessionDir, sessionId)).catch(() => {});
    }

    async function startQR() {
        try {
            const { version } = await fetchLatestBaileysVersion();
            const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
            
            const sock = makeWASocket({
                version,
                auth: state,
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }),
                browser: Browsers.macOS("Cloud-AI"),
                markOnlineOnConnect: true
            });

            sock.ev.on('creds.update', saveCreds);
            
            sock.ev.on("connection.update", async (update) => {
                const { connection, qr, lastDisconnect } = update;
                
                if (qr && !responseSent) {
                    const qrImage = await QRCode.toDataURL(qr);
                    if (!res.headersSent) {
                        res.send(`
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <title>Cloud-AI QR Code</title>
                                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                <style>
                                    body {
                                        display: flex;
                                        justify-content: center;
                                        align-items: center;
                                        min-height: 100vh;
                                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                        font-family: Arial, sans-serif;
                                    }
                                    .container {
                                        text-align: center;
                                        background: white;
                                        padding: 30px;
                                        border-radius: 20px;
                                        box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                                    }
                                    .qr-code {
                                        margin: 20px 0;
                                        padding: 20px;
                                        background: white;
                                        border-radius: 10px;
                                    }
                                    img { width: 250px; height: 250px; }
                                    h1 { color: #333; margin-bottom: 10px; }
                                    p { color: #666; }
                                    .back-btn {
                                        display: inline-block;
                                        margin-top: 20px;
                                        padding: 10px 20px;
                                        background: #667eea;
                                        color: white;
                                        text-decoration: none;
                                        border-radius: 5px;
                                    }
                                </style>
                            </head>
                            <body>
                                <div class="container">
                                    <h1>📱 Scan QR Code</h1>
                                    <div class="qr-code">
                                        <img src="${qrImage}" alt="QR Code"/>
                                    </div>
                                    <p>Scan with WhatsApp to generate session</p>
                                    <a href="/" class="back-btn">← Back to Home</a>
                                </div>
                            </body>
                            </html>
                        `);
                        responseSent = true;
                    }
                }
                
                if (connection === "open") {
                    console.log('✅ Connected!');
                    await delay(30000);
                    
                    const credsPath = path.join(sessionDir, sessionId, "creds.json");
                    if (await fs.pathExists(credsPath)) {
                        const sessionData = await fs.readFile(credsPath);
                        const megaSession = await uploadToMega(sessionData, sessionId);
                        
                        if (megaSession) {
                            await sock.sendMessage(sock.user.id, { 
                                text: `✅ *Your Cloud-AI Session ID:*\n\n\`${megaSession}\`\n\nCopy this to your .env file as SESSION_ID` 
                            });
                        }
                    }
                    
                    await delay(3000);
                    await sock.ws.close();
                    await cleanUpSession();
                }
            });

        } catch (error) {
            console.error("QR error:", error);
            if (!responseSent) {
                res.status(500).send("Service error");
            }
            await cleanUpSession();
        }
    }

    await startQR();
});

module.exports = router;
