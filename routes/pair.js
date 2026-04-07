const { 
    generateSessionId,
    removeFile,
    generateRandomCode
} = require('../gift');
const zlib = require('zlib');
const express = require('express');
const fs = require('fs');
const path = require('path');
let router = express.Router();
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

const sessionDir = path.join(__dirname, "session");

// Create session directory if not exists
if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
}

// MEGA credentials (optional - for anonymous upload)
const MEGA_EMAIL = process.env.MEGA_EMAIL || '';
const MEGA_PASSWORD = process.env.MEGA_PASSWORD || '';

async function uploadToMega(sessionData) {
    try {
        console.log('📤 Uploading to MEGA...');
        
        let file;
        if (MEGA_EMAIL && MEGA_PASSWORD) {
            const megaStorage = await File.fromURL('https://mega.nz/').login(MEGA_EMAIL, MEGA_PASSWORD);
            file = await megaStorage.upload(`session_${Date.now()}.json`, sessionData);
        } else {
            const { upload } = require('megajs');
            file = await upload(sessionData, { name: `session_${Date.now()}.json` });
        }
        
        const fileLink = await file.link();
        const match = fileLink.match(/\/file\/([^#]+)#(.+)/);
        
        if (match) {
            const sessionString = `CLOUD-AI~${match[1]}#${match[2]}`;
            console.log('✅ MEGA upload successful');
            return sessionString;
        }
        return null;
    } catch (error) {
        console.error('MEGA upload error:', error.message);
        return null;
    }
}

router.get('/', async (req, res) => {
    const id = generateSessionId(8);
    let num = req.query.number;
    let responseSent = false;
    let sessionCleanedUp = false;

    async function cleanUpSession() {
        if (!sessionCleanedUp) {
            try {
                const sessionPath = path.join(sessionDir, id);
                if (fs.existsSync(sessionPath)) {
                    await fs.promises.rm(sessionPath, { recursive: true, force: true });
                }
            } catch (error) {
                console.error("Cleanup error:", error);
            }
            sessionCleanedUp = true;
        }
    }

    async function startPairing() {
        const { version } = await fetchLatestBaileysVersion();
        console.log(`Using WA v${version.join('.')}`);
        
        const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, id));
        
        try {
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
                },
                printQRInTerminal: false,
                logger: pino({ level: "fatal" }),
                browser: Browsers.macOS("Cloud-AI"),
                syncFullHistory: false,
                generateHighQualityLinkPreview: false,
                markOnlineOnConnect: true,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 30000
            });

            if (!sock.authState.creds.registered) {
                await delay(1500);
                num = num.replace(/[^0-9]/g, '');
                
                const randomCode = generateRandomCode();
                const code = await sock.requestPairingCode(num, randomCode);
                
                if (!responseSent && !res.headersSent) {
                    res.json({ code: code });
                    responseSent = true;
                }
                console.log(`Pairing code sent to ${num}: ${code}`);
            }

            sock.ev.on('creds.update', saveCreds);
            
            sock.ev.on("connection.update", async (s) => {
                const { connection, lastDisconnect } = s;

                if (connection === "open") {
                    console.log('✅ WhatsApp connected!');
                    
                    await delay(45000);
                    
                    let sessionData = null;
                    let attempts = 0;
                    const maxAttempts = 15;
                    
                    while (attempts < maxAttempts && !sessionData) {
                        try {
                            const credsPath = path.join(sessionDir, id, "creds.json");
                            if (fs.existsSync(credsPath)) {
                                const data = fs.readFileSync(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    console.log(`✅ Session loaded (${data.length} bytes)`);
                                    break;
                                }
                            }
                            await delay(5000);
                            attempts++;
                        } catch (error) {
                            console.error("Read error:", error);
                            await delay(5000);
                            attempts++;
                        }
                    }

                    if (!sessionData) {
                        console.error('❌ No session data');
                        await cleanUpSession();
                        return;
                    }
                    
                    try {
                        // Upload to MEGA
                        const megaSession = await uploadToMega(sessionData);
                        
                        if (megaSession) {
                            // Send session to user via WhatsApp
                            const message = `╭─────────────━┈⊷
│ *✅ CLOUD-AI SESSION GENERATED*
╰─────────────━┈⊷

╭─────────────━┈⊷
│ *YOUR SESSION ID:*
│ \`\`\`${megaSession}\`\`\`
╰─────────────━┈⊷

╭─────────────━┈⊷
│ *HOW TO USE:*
│ 1. Copy the session ID above
│ 2. Add to your .env file:
│    SESSION_ID="${megaSession}"
│ 3. Restart your bot
╰─────────────━┈⊷

> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄʟᴏᴜᴅ-ᴀɪ*

📋 *COPY THIS:* ${megaSession}`;

                            await sock.sendMessage(sock.user.id, { text: message });
                            console.log('✅ Session sent to user!');
                        } else {
                            await sock.sendMessage(sock.user.id, { text: '❌ Failed to generate session. Please try again.' });
                        }
                        
                        await delay(3000);
                        await sock.ws.close();
                        
                    } catch (error) {
                        console.error("Session error:", error);
                    } finally {
                        await cleanUpSession();
                    }
                    
                } else if (connection === "close" && lastDisconnect && lastDisconnect.error && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut) {
                    console.log("Reconnecting...");
                    await delay(5000);
                    startPairing();
                }
            });

        } catch (error) {
            console.error("Main error:", error);
            if (!responseSent && !res.headersSent) {
                res.status(500).json({ code: "Service unavailable" });
                responseSent = true;
            }
            await cleanUpSession();
        }
    }

    try {
        await startPairing();
    } catch (error) {
        console.error("Final error:", error);
        await cleanUpSession();
        if (!responseSent && !res.headersSent) {
            res.status(500).json({ code: "Error" });
        }
    }
});

module.exports = router;
