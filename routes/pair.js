const { 
    generateSessionId,
    removeFile,
    generateRandomCode,
    ensureDir
} = require('../gift');
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

// Ensure session directory exists
ensureDir(sessionDir);

// MEGA Credentials (Create a free MEGA account for this)
const MEGA_EMAIL = process.env.MEGA_EMAIL || '';
const MEGA_PASSWORD = process.env.MEGA_PASSWORD || '';

/**
 * Upload session file to MEGA.nz
 * Returns file ID and decryption key in format: CLOUD-AI~fileID#key
 */
async function uploadToMega(sessionData, sessionId) {
    try {
        console.log('📤 Uploading session to MEGA...');
        
        // Create temporary file
        const tempFilePath = path.join(sessionDir, `${sessionId}_creds.json`);
        await fs.writeFile(tempFilePath, sessionData);
        
        // Upload to MEGA
        let file;
        
        if (MEGA_EMAIL && MEGA_PASSWORD) {
            // Login to MEGA account
            const megaStorage = await File.fromURL('https://mega.nz/').login(MEGA_EMAIL, MEGA_PASSWORD);
            file = await megaStorage.upload(`session_${sessionId}.json`, sessionData);
        } else {
            // Anonymous upload (file expires after ~30 days)
            const { upload } = require('megajs');
            file = await upload(sessionData, { name: `session_${sessionId}.json` });
        }
        
        // Get file link
        const fileLink = await file.link();
        
        // Parse file ID and key from URL
        // Format: https://mega.nz/file/FILEID#DECRYPTKEY
        const match = fileLink.match(/\/file\/([^#]+)#(.+)/);
        
        if (match) {
            const fileId = match[1];
            const decryptKey = match[2];
            const megaSessionString = `CLOUD-AI~${fileId}#${decryptKey}`;
            
            console.log('✅ MEGA upload successful!');
            console.log(`   File ID: ${fileId}`);
            console.log(`   Key: ${decryptKey}`);
            
            // Clean up temp file
            await fs.remove(tempFilePath).catch(() => {});
            
            return {
                success: true,
                fileId: fileId,
                decryptKey: decryptKey,
                sessionString: megaSessionString
            };
        } else {
            throw new Error('Failed to parse MEGA link');
        }
        
    } catch (error) {
        console.error('❌ MEGA upload error:', error.message);
        
        // Fallback: Create local file link (for development)
        const localFilePath = path.join(sessionDir, `${sessionId}_creds.json`);
        return {
            success: true,
            fileId: 'local',
            decryptKey: 'local',
            sessionString: `CLOUD-AI~local#${sessionId}`,
            localFile: localFilePath,
            isLocal: true
        };
    }
}

router.get('/', async (req, res) => {
    const sessionId = generateSessionId(8);
    let phoneNumber = req.query.number;
    let responseSent = false;
    let sessionCleanedUp = false;

    async function cleanUpSession() {
        if (!sessionCleanedUp) {
            try {
                await removeFile(path.join(sessionDir, sessionId));
            } catch (error) {
                console.error("Cleanup error:", error);
            }
            sessionCleanedUp = true;
        }
    }

    async function startPairing() {
        try {
            const { version } = await fetchLatestBaileysVersion();
            console.log(`📱 Using WhatsApp version: ${version.join('.')}`);
            
            const { state, saveCreds } = await useMultiFileAuthState(path.join(sessionDir, sessionId));
            
            const sock = makeWASocket({
                version,
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" }))
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

            // Request pairing code
            if (!sock.authState.creds.registered) {
                await delay(1500);
                phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
                
                const pairingCode = generateRandomCode();
                const code = await sock.requestPairingCode(phoneNumber, pairingCode);
                
                if (!responseSent && !res.headersSent) {
                    res.json({ code: code });
                    responseSent = true;
                }
                console.log(`📱 Pairing code sent to ${phoneNumber}: ${code}`);
            }

            // Handle credentials update
            sock.ev.on('creds.update', saveCreds);

            // Handle connection updates
            sock.ev.on("connection.update", async (update) => {
                const { connection, lastDisconnect } = update;

                if (connection === "open") {
                    console.log('✅ WhatsApp connected successfully!');
                    
                    // Wait for session to be fully saved
                    await delay(30000);
                    
                    // Read the session file
                    let sessionData = null;
                    let attempts = 0;
                    const maxAttempts = 10;
                    
                    while (attempts < maxAttempts && !sessionData) {
                        try {
                            const credsPath = path.join(sessionDir, sessionId, "creds.json");
                            if (await fs.pathExists(credsPath)) {
                                const data = await fs.readFile(credsPath);
                                if (data && data.length > 100) {
                                    sessionData = data;
                                    console.log(`✅ Session data loaded (${data.length} bytes)`);
                                    break;
                                }
                            }
                            await delay(3000);
                            attempts++;
                        } catch (error) {
                            console.error("Read error:", error);
                            await delay(3000);
                            attempts++;
                        }
                    }

                    if (!sessionData) {
                        console.error('❌ Failed to read session data');
                        await cleanUpSession();
                        return;
                    }
                    
                    try {
                        // Upload to MEGA and get session string
                        console.log('📤 Uploading session to MEGA...');
                        const megaResult = await uploadToMega(sessionData, sessionId);
                        
                        if (megaResult.success) {
                            // Send session ID to user via WhatsApp
                            const sessionMessage = `╭─────────────━┈⊷
│ *✅ CLOUD-AI SESSION GENERATED*
╰─────────────━┈⊷

╭─────────────━┈⊷
│ *SESSION FORMAT:*
│ \`\`\`${megaResult.sessionString}\`\`\`
│
│ *FILE ID:* ${megaResult.fileId}
│ *KEY:* ${megaResult.decryptKey}
╰─────────────━┈⊷

╭─────────────━┈⊷
│ *HOW TO USE:*
│ 1. Copy the session string above
│ 2. Add to your .env file:
│    SESSION_ID="${megaResult.sessionString}"
│ 3. Restart your bot
╰─────────────━┈⊷

> *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄʟᴏᴜᴅ-ᴀɪ*`;

                            await sock.sendMessage(sock.user.id, { text: sessionMessage });
                            console.log('✅ Session ID sent to user!');
                            
                            // Send as copyable button
                            await sock.sendMessage(sock.user.id, {
                                text: `📋 *Click below to copy your session ID:*\n\n\`${megaResult.sessionString}\``,
                                buttons: [
                                    {
                                        buttonId: 'copy',
                                        buttonText: { displayText: '📋 Copy Session ID' },
                                        type: 1
                                    }
                                ]
                            });
                        } else {
                            await sock.sendMessage(sock.user.id, { 
                                text: '❌ Failed to generate session. Please try again.' 
                            });
                        }
                        
                        await delay(5000);
                        await sock.ws.close();
                        
                    } catch (error) {
                        console.error("Session processing error:", error);
                        await sock.sendMessage(sock.user.id, { 
                            text: `❌ Error: ${error.message}` 
                        });
                    } finally {
                        await cleanUpSession();
                    }
                    
                } else if (connection === "close") {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    console.log(`Connection closed with code: ${statusCode}`);
                    
                    if (statusCode !== DisconnectReason.loggedOut) {
                        console.log("Reconnecting...");
                        await delay(5000);
                        startPairing();
                    } else {
                        console.log("Logged out, cleaning up...");
                        await cleanUpSession();
                    }
                }
            });

        } catch (error) {
            console.error("Main error:", error);
            if (!responseSent && !res.headersSent) {
                res.status(500).json({ code: "Service temporarily unavailable" });
                responseSent = true;
            }
            await cleanUpSession();
        }
    }

    try {
        await startPairing();
    } catch (finalError) {
        console.error("Final error:", finalError);
        await cleanUpSession();
        if (!responseSent && !res.headersSent) {
            res.status(500).json({ code: "Service error, please try again" });
        }
    }
});

module.exports = router;
