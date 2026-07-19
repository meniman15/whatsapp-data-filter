const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ['--no-sandbox'] }
});

client.on('qr', (qr) => {
    console.log('--- QR CODE ---');
    console.log('Scan this QR code with WhatsApp to log in and list your channels:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n✅ Client is ready! Fetching your chats & channels...\n');
    
    try {
        const chats = await client.getChats();
        
        console.log('--- YOUR CHANNELS & GROUPS ---');
        chats.forEach(chat => {
            if (chat.isGroup || chat.isChannel) {
                const type = chat.isChannel ? 'CHANNEL' : 'GROUP';
                console.log(`[${type}] Name: "${chat.name}" | ID: ${chat.id._serialized}`);
            }
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
