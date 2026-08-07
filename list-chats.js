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

cleanupStaleSessionLocks();

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
    console.log('\n✅ Client is ready! Fetching your chats & channels...\n');
    
    try {
        // Direct in-memory Store query to bypass whatsapp-web.js getChats() 'r: r' bug
        const chats = await client.pupPage.evaluate(() => {
            if (!window.Store || !window.Store.Chat) return [];
            return window.Store.Chat.getModelsArray().map(c => {
                const isGrp = c.isGroup || (c.id && c.id._serialized ? c.id._serialized.endsWith('@g.us') : false);
                const isCh = c.isChannel || (c.id && c.id._serialized ? c.id._serialized.endsWith('@newsletter') : false);
                return {
                    name: c.name || c.formattedTitle || (c.id ? c.id._serialized : 'Unknown'),
                    id: c.id ? c.id._serialized : null,
                    isGroup: isGrp,
                    isChannel: isCh
                };
            }).filter(c => c.id && (c.isGroup || c.isChannel));
        });
        
        console.log('--- YOUR CHANNELS & GROUPS ---');
        chats.forEach(chat => {
            const type = chat.isChannel ? 'CHANNEL' : 'GROUP';
            console.log(`[${type}] Name: "${chat.name}" | ID: ${chat.id}`);
        });
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
