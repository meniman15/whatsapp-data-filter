const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

const client = new Client({
    authStrategy: new LocalAuth(),
    authTimeoutMs: 60000,
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('--- QR CODE ---');
    console.log('Scan this QR code with WhatsApp to log in:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', async () => {
    console.log('\n✅ WhatsApp Client is ready! Fetching your chats & channels...\n');
    
    try {
        const chats = await client.getChats();
        
        // Filter for groups and channels
        const availableChats = chats
            .filter(chat => chat.isGroup || chat.isChannel)
            .map(chat => ({
                name: `${chat.isChannel ? '[CHANNEL]' : '[GROUP]'} ${chat.name}`,
                value: chat.id._serialized,
                rawName: chat.name
            }));
            
        if (availableChats.length === 0) {
            console.log('⚠️ No groups or channels found on this account.');
            console.log('Please make sure you have joined or created at least one group or channel.');
            await client.destroy();
            process.exit(1);
        }

        console.log(`📋 Found ${availableChats.length} groups and channels.\n`);

        const config = {};

        // 1. SELECT SOURCE CHANNEL/GROUP
        const sourceMethod = await inquirer.prompt([
            {
                type: 'list',
                name: 'method',
                message: 'How would you like to select the SOURCE channel/group (where jobs are posted)?',
                choices: [
                    { name: 'Select from list of all groups/channels', value: 'list' },
                    { name: 'Search by name', value: 'search' },
                    { name: 'Enter ID manually', value: 'manual' }
                ]
            }
        ]);

        if (sourceMethod.method === 'list') {
            const answer = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'id',
                    message: 'Select the SOURCE channel/group:',
                    choices: availableChats
                }
            ]);
            config.SOURCE_CHANNEL_ID = answer.id;
        } else if (sourceMethod.method === 'search') {
            const searchAns = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'query',
                    message: 'Enter search term (part of the group/channel name):',
                    validate: input => input.trim().length > 0 ? true : 'Please enter a search term.'
                }
            ]);
            
            const query = searchAns.query.toLowerCase();
            const filtered = availableChats.filter(c => c.rawName.toLowerCase().includes(query));
            
            if (filtered.length === 0) {
                console.log('❌ No groups or channels matched your search. Falling back to manual entry.');
                const manual = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'id',
                        message: 'Enter the SOURCE channel/group ID manually:',
                        validate: input => input.trim().length > 0 ? true : 'ID cannot be empty.'
                    }
                ]);
                config.SOURCE_CHANNEL_ID = manual.id;
            } else {
                const answer = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'id',
                        message: 'Select the SOURCE channel/group:',
                        choices: filtered
                    }
                ]);
                config.SOURCE_CHANNEL_ID = answer.id;
            }
        } else {
            const manual = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'id',
                    message: 'Enter the SOURCE channel/group ID manually:',
                    validate: input => input.trim().length > 0 ? true : 'ID cannot be empty.'
                }
            ]);
            config.SOURCE_CHANNEL_ID = manual.id;
        }

        // 2. SELECT DESTINATION CHANNEL/GROUP
        const destMethod = await inquirer.prompt([
            {
                type: 'list',
                name: 'method',
                message: 'How would you like to select the DESTINATION channel/group (where filtered jobs will be sent)?',
                choices: [
                    { name: 'Select from list of all groups/channels', value: 'list' },
                    { name: 'Search by name', value: 'search' },
                    { name: 'Enter ID manually', value: 'manual' }
                ]
            }
        ]);

        if (destMethod.method === 'list') {
            const answer = await inquirer.prompt([
                {
                    type: 'list',
                    name: 'id',
                    message: 'Select the DESTINATION channel/group:',
                    choices: availableChats
                }
            ]);
            config.DESTINATION_CHANNEL_ID = answer.id;
        } else if (destMethod.method === 'search') {
            const searchAns = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'query',
                    message: 'Enter search term (part of the group/channel name):',
                    validate: input => input.trim().length > 0 ? true : 'Please enter a search term.'
                }
            ]);
            
            const query = searchAns.query.toLowerCase();
            const filtered = availableChats.filter(c => c.rawName.toLowerCase().includes(query));
            
            if (filtered.length === 0) {
                console.log('❌ No groups or channels matched your search. Falling back to manual entry.');
                const manual = await inquirer.prompt([
                    {
                        type: 'input',
                        name: 'id',
                        message: 'Enter the DESTINATION channel/group ID manually:',
                        validate: input => input.trim().length > 0 ? true : 'ID cannot be empty.'
                    }
                ]);
                config.DESTINATION_CHANNEL_ID = manual.id;
            } else {
                const answer = await inquirer.prompt([
                    {
                        type: 'list',
                        name: 'id',
                        message: 'Select the DESTINATION channel/group:',
                        choices: filtered
                    }
                ]);
                config.DESTINATION_CHANNEL_ID = answer.id;
            }
        } else {
            const manual = await inquirer.prompt([
                {
                    type: 'input',
                    name: 'id',
                    message: 'Enter the DESTINATION channel/group ID manually:',
                    validate: input => input.trim().length > 0 ? true : 'ID cannot be empty.'
                }
            ]);
            config.DESTINATION_CHANNEL_ID = manual.id;
        }

        // Update the .env file
        updateEnv(config);
        
        console.log('\n✨ Setup completed successfully!');
        console.log(`📡 Source ID set to: ${config.SOURCE_CHANNEL_ID}`);
        console.log(`🎯 Destination ID set to: ${config.DESTINATION_CHANNEL_ID}`);
        console.log('\n👉 You can now start the bot by running:');
        console.log('node index.js\n');

        await client.destroy();
        process.exit(0);
    } catch (err) {
        console.error('Error during setup wizard:', err);
        try {
            await client.destroy();
        } catch (_) {}
        process.exit(1);
    }
});

function updateEnv(updates) {
    const envPath = path.join(__dirname, '.env');
    let envContent = '';
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }
    
    let lines = envContent.split('\n');
    for (const key of Object.keys(updates)) {
        const value = updates[key];
        let found = false;
        lines = lines.map(line => {
            if (line.trim().startsWith(`${key}=`)) {
                found = true;
                return `${key}=${value}`;
            }
            return line;
        });
        if (!found) {
            lines.push(`${key}=${value}`);
        }
    }
    fs.writeFileSync(envPath, lines.join('\n'), 'utf8');
}

client.initialize().catch(async (err) => {
    console.error('Initialization error:', err);
    try {
        await client.destroy();
    } catch (_) {}
    process.exit(1);
});
