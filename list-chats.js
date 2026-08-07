const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const fs = require('fs');
const path = require('path');

function cleanupStaleSessionLocks() {
    const sessionDir = path.join(__dirname, '.wwebjs_auth', 'session');
    if (fs.existsSync(sessionDir)) {
        const lockFile = path.join(sessionDir, 'SingletonLock');
        if (fs.existsSync(lockFile)) {
            try {
                fs.unlinkSync(lockFile);
            } catch (_) {}
        }
    }
}

console.log('🚀 Starting WhatsApp Chat Lister...');
console.log('🧹 Cleaning up stale Chrome session locks...');
cleanupStaleSessionLocks();

console.log('🌐 Launching Headless Chrome & connecting to WhatsApp (expected wait: ~10-20 seconds)...');

const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 60000,
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('--- QR CODE ---');
    console.log('Scan this QR code with WhatsApp to log in and list your channels:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n✅ WhatsApp Web connected!');
    console.log('📡 Syncing chat models from memory (polling up to 4 attempts, 5s per attempt)...');
    
    try {
        let chats = [];
        let attempts = 0;
        const maxAttempts = 4;

        while (chats.length === 0 && attempts < maxAttempts) {
            attempts++;
            console.log(`⏳ Syncing WhatsApp Web chat models (Attempt ${attempts}/${maxAttempts})...`);
            await new Promise(resolve => setTimeout(resolve, 5000));

            chats = await client.pupPage.evaluate(() => {
                let rawModels = [];
                
                // Source 1: window.Store.Chat
                if (window.Store && window.Store.Chat) {
                    if (typeof window.Store.Chat.getModelsArray === 'function') {
                        rawModels = window.Store.Chat.getModelsArray();
                    } else if (Array.isArray(window.Store.Chat.models)) {
                        rawModels = window.Store.Chat.models;
                    } else if (Array.isArray(window.Store.Chat._models)) {
                        rawModels = window.Store.Chat._models;
                    }
                }

                // Source 2: Webpack WAWebChatCollection
                if (!rawModels || rawModels.length === 0) {
                    try {
                        const chatMod = window.require('WAWebChatCollection');
                        const chatColl = chatMod && (chatMod.ChatCollection || chatMod.default || chatMod);
                        if (chatColl) {
                            if (typeof chatColl.getModelsArray === 'function') {
                                rawModels = chatColl.getModelsArray();
                            } else if (Array.isArray(chatColl.models)) {
                                rawModels = chatColl.models;
                            }
                        }
                    } catch (_) {}
                }

                // Source 3: Webpack WAWebGroupMetadataCollection
                if (!rawModels || rawModels.length === 0) {
                    try {
                        const groupMod = window.require('WAWebGroupMetadataCollection');
                        const groupColl = groupMod && (groupMod.GroupMetadataCollection || groupMod.default || groupMod);
                        if (groupColl) {
                            if (typeof groupColl.getModelsArray === 'function') {
                                rawModels = groupColl.getModelsArray();
                            } else if (Array.isArray(groupColl.models)) {
                                rawModels = groupColl.models;
                            }
                        }
                    } catch (_) {}
                }

                return (rawModels || []).map(c => {
                    const idStr = c.id ? (c.id._serialized || c.id.id || (typeof c.id === 'string' ? c.id : null)) : null;
                    const isGrp = c.isGroup || (typeof idStr === 'string' && idStr.endsWith('@g.us'));
                    const isCh = c.isChannel || (typeof idStr === 'string' && idStr.endsWith('@newsletter'));
                    return {
                        name: c.name || c.formattedTitle || c.subject || idStr || 'Unknown',
                        id: idStr,
                        isGroup: isGrp,
                        isChannel: isCh
                    };
                }).filter(c => c.id && (c.isGroup || c.isChannel));
            });
        }
        
        console.log('\n--- YOUR CHANNELS & GROUPS ---');
        if (chats.length === 0) {
            console.log('⚠️ No groups or channels were found. Please verify your phone is connected and in at least 1 group.');
        } else {
            chats.forEach(chat => {
                const type = chat.isChannel ? 'CHANNEL' : 'GROUP';
                console.log(`[${type}] Name: "${chat.name}" | ID: ${chat.id}`);
            });
        }
        console.log('------------------------------\n');
        
        console.log('👉 Copy the IDs of your source and destination channels into the .env file.');
        console.log('After setting up the .env file, you can start the bot by running:');
        console.log('node index.js');
        
        await client.destroy();
        process.exit(0);
    } catch (err) {
        console.error('Error fetching chats:', err);
        try {
            await client.destroy();
        } catch (destroyErr) {
            console.error('Error destroying client:', destroyErr);
        }
        process.exit(1);
    }
});

client.initialize().catch(async (err) => {
    console.error('Initialization error:', err);
    try {
        await client.destroy();
    } catch (_) {}
    process.exit(1);
});
