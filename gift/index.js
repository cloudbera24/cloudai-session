const fs = require('fs-extra');
const path = require('path');

function generateSessionId(length = 6) {
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function generateRandomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 8; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function removeFile(filePath) {
    if (!fs.existsSync(filePath)) return false;
    await fs.remove(filePath);
    return true;
}

async function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        await fs.ensureDir(dirPath);
    }
    return true;
}

module.exports = {
    generateSessionId,
    generateRandomCode,
    removeFile,
    ensureDir
};
