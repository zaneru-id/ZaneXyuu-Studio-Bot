const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ButtonStyle, SlashCommandBuilder, ActivityType, PresenceUpdateStatus } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const dotEnvPath = fs.existsSync(path.join(__dirname, '.env'))
    ? path.join(__dirname, '.env')
    : fs.existsSync(path.join(__dirname, 'env'))
        ? path.join(__dirname, 'env')
        : undefined;
if (dotEnvPath) {
    require('dotenv').config({ path: dotEnvPath });
} else {
    require('dotenv').config();
}
const ffmpegPath = require('ffmpeg-static');

const { GUILD_ID, CATEGORY_ID, LOG_CHANNEL_IDS, AUDIO_REMIX_CHANNEL_IDS, VOUCH_CHANNEL_ID, WELCOME_CHANNEL_ID, VERIFY_ROLE_ID, SPENDER_ROLES, ADMIN_USER_IDS } = require('./config');

const COUNTER_FILE = 'ticket_counter.txt';
const TRANSAKSI_FILE = 'transaksi_data.json';
const LEADERBOARD_FILE = 'leaderboard.json';
const STICKY_FILE = 'sticky_messages.json';

const LAST_ANNOUNCEMENT = {
    messageId: null,
    channelId: null
};


function sanitizeFilename(text) {
    return (text || 'audio')
        .replace(/[<>:"\/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

function ensureTempDir() {
    const dir = path.join(__dirname, 'temp_audio');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

const SUPPORTED_AUDIO_EXTENSIONS = ['.mp3', '.ogg', '.flac', '.wav'];

function getAttachmentFilename(attachment) {
    const url = attachment.url || attachment.proxyURL || '';
    const name = attachment.name || path.basename(url.split('?')[0] || 'audio');
    return sanitizeFilename(name);
}

function isSupportedAudioAttachment(attachment) {
    const name = attachment.name || path.basename((attachment.url || attachment.proxyURL || '').split('?')[0] || '');
    const ext = path.extname(name).toLowerCase();
    return SUPPORTED_AUDIO_EXTENSIONS.includes(ext);
}

function looksLikeAudioAttachment(attachment) {
    return attachment.contentType?.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|flac|aac|opus)$/i.test(attachment.name || '');
}

async function downloadAttachment(attachment, destination) {
    const response = await fetch(attachment.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new Error(`Attachment download failed: ${response.status}`);
    const body = response.body;
    if (!body) throw new Error('No response body for attachment');

    const fileStream = fs.createWriteStream(destination);
    return new Promise((resolve, reject) => {
        const sourceStream = typeof body.pipe === 'function' ? body : Readable.fromWeb(body);
        sourceStream.on('error', reject);
        sourceStream.pipe(fileStream);
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
    });
}

const AUDIO_EFFECT_FORMAT_TEMPLATE = `Audio effect format:

Bass Boost = 0-10
Vocal Boost = 0-10
Bright TV = 0-10
Warm Low = 0-10
Smooth Mid = 0-10
Deep Bass = 0-10
Clear Voice = 0-10
Punchy Bass = 0-10
Low Shelf = 0-10
High Shelf = 0-10
Speed = 0.1-3

Example:
Bass Boost = 3
Vocal Boost = 2.5
Speed = 1.2
Speed = 0.55
Low Shelf = false
High Shelf = 1.5
`;

function buildSpeedFilter(value) {
    const speed = Math.min(Math.max(value, 0.1), 3);
    if (speed >= 0.5 && speed <= 3) {
        return `atempo=${speed}`;
    }
    return `asetrate=sample_rate*${speed},aresample=sample_rate`;
}

const AUDIO_EFFECT_BUILDERS = {
    'bass boost': value => ({ name: 'Bass Boost', value, filter: `equalizer=f=60:t=q:w=1:g=${value}` }),
    'vocal boost': value => ({ name: 'Vocal Boost', value, filter: `equalizer=f=1000:t=q:w=1:g=${value}` }),
    'bright tv': value => ({ name: 'Bright TV', value, filter: `equalizer=f=8000:t=q:w=1:g=${value}` }),
    'warm low': value => ({ name: 'Warm Low', value, filter: `equalizer=f=120:t=q:w=1:g=${value}` }),
    'smooth mid': value => ({ name: 'Smooth Mid', value, filter: `equalizer=f=800:t=q:w=1:g=${value}` }),
    'deep bass': value => ({ name: 'Deep Bass', value, filter: `equalizer=f=50:t=q:w=1:g=${value}` }),
    'clear voice': value => ({ name: 'Clear Voice', value, filter: `equalizer=f=3000:t=q:w=1:g=${value}` }),
    'punchy bass': value => ({ name: 'Punchy Bass', value, filter: `equalizer=f=80:t=q:w=1:g=${value}` }),
    'low shelf': value => ({ name: 'Low Shelf', value, filter: `equalizer=f=120:t=q:w=1:g=${value}` }),
    'high shelf': value => ({ name: 'High Shelf', value, filter: `equalizer=f=12000:t=q:w=1:g=${value}` }),
    'speed': value => ({ name: 'Speed', value, filter: buildSpeedFilter(value) })
};

function parseAudioEffectSettings(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const settings = [];
    for (const line of lines) {
        const match = line.match(/^([^=:\n]+)\s*(?:=|:)\s*(.+)$/i);
        if (!match) continue;

        const rawName = match[1].trim().toLowerCase();
        let rawValue = match[2].trim().toLowerCase();
        if (rawValue === 'false' || rawValue === 'off' || rawValue === 'no') continue;
        if (rawValue.startsWith('x')) {
            rawValue = rawValue.slice(1).trim();
        }

        const normalizedName = Object.keys(AUDIO_EFFECT_BUILDERS).find(key => key === rawName || key.replace(/\s+/g, '') === rawName.replace(/\s+/g, ''));
        if (!normalizedName) continue;

        const value = parseFloat(rawValue);
        if (Number.isNaN(value) || value <= 0) continue;

        const clamped = Math.min(Math.max(value, 0), 10);
        settings.push(AUDIO_EFFECT_BUILDERS[normalizedName](clamped));
    }

    if (settings.length === 0) return null;
    return {
        name: settings.map(item => item.name).join(' + '),
        filter: settings.map(item => item.filter).join(', '),
        effects: settings
    };
}

function chooseRandomAudioEffect() {
    const effects = [
        { name: 'Bass Boost', filter: 'equalizer=f=60:t=q:w=1:g=5' },
        { name: 'Vocal Boost', filter: 'equalizer=f=1000:t=q:w=1:g=4' },
        { name: 'Bright TV', filter: 'equalizer=f=8000:t=q:w=1:g=3' },
        { name: 'Warm Low', filter: 'equalizer=f=120:t=q:w=1:g=4' },
        { name: 'Smooth Mid', filter: 'equalizer=f=800:t=q:w=1:g=3' },
        { name: 'Deep Bass', filter: 'equalizer=f=50:t=q:w=1:g=6' },
        { name: 'Clear Voice', filter: 'equalizer=f=3000:t=q:w=1:g=2.5' },
        { name: 'Punchy Bass', filter: 'equalizer=f=80:t=q:w=1:g=5' },
        { name: 'Low Shelf', filter: 'equalizer=f=120:t=q:w=1:g=3' },
        { name: 'High Shelf', filter: 'equalizer=f=12000:t=q:w=1:g=3' }
    ];

    const filterCount = 2 + Math.floor(Math.random() * 2); // choose 2-3 random equalizers
    const selected = [];
    const available = [...effects];

    for (let i = 0; i < filterCount && available.length > 0; i += 1) {
        const index = Math.floor(Math.random() * available.length);
        selected.push(available.splice(index, 1)[0]);
    }

    return {
        name: selected.map(effect => effect.name).join(' + '),
        filter: selected.map(effect => effect.filter).join(', ')
    };
}

async function convertAudioToOgg(inputPath, outputPath, effectFilter = null) {
    const filters = effectFilter ? `${effectFilter},aformat=channel_layouts=stereo,aresample=48000` : 'aformat=channel_layouts=stereo,aresample=48000';
    return new Promise((resolve, reject) => {
        execFile(ffmpegPath, [
            '-y',
            '-i', inputPath,
            '-af', filters,
            '-c:a', 'libopus',
            '-b:a', '192k',
            outputPath
        ], (error) => {
            if (error) return reject(error);
            resolve();
        });
    });
}

async function processAttachmentAudio(message, attachment, title, effectSettings = null) {
    const statusMessage = await message.reply({ content: '<a:Thunder:1277088364570607616> Applying audio, please wait...', allowedMentions: { repliedUser: false } });
    const tempDir = ensureTempDir();
    const attachmentName = getAttachmentFilename(attachment);
    const extension = path.extname(attachmentName) || '.tmp';
    const filenameBase = sanitizeFilename(title || path.basename(attachmentName, extension) || 'audio-file');
    const rawPath = path.join(tempDir, `${filenameBase}${extension}`);
    const outputPath = path.join(tempDir, `${filenameBase}.ogg`);
    const activeSticky = stickyMessages[message.channel.id];

    const effect = effectSettings || chooseRandomAudioEffect();
    const startTime = Date.now();
    const steps = effectSettings
        ? effectSettings.effects.map(effectItem => `<a:Loading:1278035715938062377> Applying ${effectItem.name} = ${effectItem.value}...`)
        : [`<a:Loading:1278035715938062377> Applying random effect: ${effect.name}...`];

    try {
        await downloadAttachment(attachment, rawPath);

        for (const step of steps) {
            await statusMessage.edit({ content: step, allowedMentions: { repliedUser: false } });
            await wait(600);
        }

        console.log(`Audio effect applied (attachment): ${effect.name}`);
        console.log(`Audio filter chain (attachment): ${effect.filter}`);
        await convertAudioToOgg(rawPath, outputPath, effect.filter);

        const timeTaken = ((Date.now() - startTime) / 1000).toFixed(2);
        const embed = new EmbedBuilder()
            .setTitle('<a:Success:1522350069658161311> Audio successfully remixed')
            .setColor(0x00ffcc)
            .setTimestamp()
            .setFooter({ text: 'Powered by ZaneXyuu Studio', iconURL: 'https://cdn.discordapp.com/emojis/1276232127817584670.gif?size=512' })
            .addFields(
                {
                    name: 'Effect Applied',
                    value: effectSettings
                        ? effectSettings.effects.map(effectItem => `<a:Done:1504531338340995173> ${effectItem.name} = ${effectItem.value}`).join('\n')
                        : `<a:Done:1504531338340995173> ${effect.name}`,
                    inline: false
                },
                {
                    name: 'Time Taken',
                    value: `<a:Clock:1522350501017161779> ${timeTaken}s`,
                    inline: true
                }
            );

        await message.reply({
            embeds: [embed],
            files: [{ attachment: outputPath, name: `${filenameBase}.ogg` }],
            allowedMentions: { repliedUser: false }
        });

        if (activeSticky && activeSticky.messageId) {
            await setStickyMessage(message.channel, activeSticky.content).catch(() => {});
        }
    } catch (error) {
        console.error('Attachment audio processing error:', error);
        await message.reply({
            content: '❌ Failed to process audio. Please upload a valid audio file.',
            allowedMentions: { repliedUser: false }
        });
    } finally {
        statusMessage.delete().catch(() => {});
        [rawPath, outputPath].forEach(file => {
            if (fs.existsSync(file)) {
                try { fs.unlinkSync(file); } catch (err) {}
            }
        });
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.on('error', error => console.error('[Discord Client Error]', error));
client.on('warn', warning => console.warn('[Discord Client Warning]', warning));
client.on('shardError', error => console.error('[Shard Error]', error));
client.on('invalidated', () => console.warn('[Discord Client Invalidated] Session invalidated, reconnecting...'));
client.on('rateLimit', info => console.warn('[Discord RateLimit]', info));
client.on('reconnecting', () => console.warn('[Discord Client Reconnecting]'));
client.on('disconnect', event => console.warn('[Discord Client Disconnected]', event));

const vouchData = new Map();

function getNextTicketNumber() {
    let current = 1;
    if (fs.existsSync(COUNTER_FILE)) {
        current = parseInt(fs.readFileSync(COUNTER_FILE, 'utf8').trim());
    } else {
        fs.writeFileSync(COUNTER_FILE, '1');
    }
    fs.writeFileSync(COUNTER_FILE, (current + 1).toString());
    return current;
}

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
            const name = interaction.commandName;
            if (name === 'announce') {
                if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                    return await interaction.reply({ content: "⚠️ Kamu tidak punya izin", flags: 64 });
                }

                const channel = interaction.options.getChannel('channel');
                const mention = interaction.options.getString('mention') || 'none';
                const delay = interaction.options.getInteger('delay') || 0;

                const customId = `announce|${channel.id}|${mention}|${delay}`;
                const modal = new ModalBuilder()
                    .setCustomId(customId)
                    .setTitle('Create Announcement');

                const titleInput = new TextInputBuilder()
                    .setCustomId('title')
                    .setLabel('Title')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true);

                const descInput = new TextInputBuilder()
                    .setCustomId('description')
                    .setLabel('Text Pengumuman')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true);

                const imageInput = new TextInputBuilder()
                    .setCustomId('image')
                    .setLabel('Image URL (opsional)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                const thumbInput = new TextInputBuilder()
                    .setCustomId('thumb')
                    .setLabel('Thumbnail URL (opsional)')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false);

                modal.addComponents(
                    new ActionRowBuilder().addComponents(titleInput),
                    new ActionRowBuilder().addComponents(descInput),
                    new ActionRowBuilder().addComponents(imageInput),
                    new ActionRowBuilder().addComponents(thumbInput),
                );

                await interaction.showModal(modal);
                return;
            }

            if (name === 'edit_announcement') {
                if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                    return await interaction.reply({ content: "⚠️ Kamu tidak punya izin", flags: 64 });
                }

                const newText = interaction.options.getString('new_text');
                if (!LAST_ANNOUNCEMENT.messageId) {
                    return await interaction.reply({ content: '❌ Tidak ada announcement.', flags: 64 });
                }

                const channel = await client.channels.fetch(LAST_ANNOUNCEMENT.channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    return await interaction.reply({ content: '❌ Channel tidak ditemukan.', flags: 64 });
                }

                try {
                    const msg = await channel.messages.fetch(LAST_ANNOUNCEMENT.messageId);
                    if (!msg.embeds || msg.embeds.length === 0) {
                        return await interaction.reply({ content: '❌ Announcement tidak memiliki embed.', flags: 64 });
                    }
                    const embed = EmbedBuilder.from(msg.embeds[0]);
                    embed.setDescription(newText);
                    embed.setTimestamp(Date.now());
                    await msg.edit({ embeds: [embed] });
                    return await interaction.reply({ content: '✅ Announcement berhasil diedit.', flags: 64 });
                } catch (e) {
                    return await interaction.reply({ content: '❌ Gagal mengedit message.', flags: 64 });
                }
            }
        }

        if (interaction.isModalSubmit && interaction.isModalSubmit()) {
            const customId = interaction.customId || '';
            if (customId.startsWith('announce|')) {
                await interaction.deferReply({ flags: 64 });
                const parts = customId.split('|');
                const channelId = parts[1];
                const mentionType = parts[2] || 'none';
                const delay = parseInt(parts[3] || '0', 10) || 0;

                const channel = await client.channels.fetch(channelId).catch(() => null);
                if (!channel || !channel.isTextBased()) {
                    return await interaction.followUp({ content: '❌ Channel announcement tidak valid.', flags: 64 });
                }

                const title = interaction.fields.getTextInputValue('title');
                const description = interaction.fields.getTextInputValue('description');
                const image = interaction.fields.getTextInputValue('image');
                const thumb = interaction.fields.getTextInputValue('thumb');

                const embed = new EmbedBuilder()
                    .setTitle(`<a:Announce:1504860930587103374> ${title}`)
                    .setDescription(description)
                    .setColor(0x02AEF7)
                    .setTimestamp(Date.now())
                    .setFooter({ text: 'Message by ZaneXyuu Studio', iconURL: 'https://cdn.discordapp.com/attachments/1374335784613843000/1504522284789010524/pp.png?ex=6a07f3d1&is=6a06a251&hm=fd81982120b36ae1be5a4d29c00df91a99f5315315577cb53a704bb2384f2699' });

                if (image) embed.setImage(image);
                if (thumb) embed.setThumbnail(thumb);

                const mentionText = mentionType === 'everyone' ? '@everyone' : (mentionType === 'here' ? '@here' : '');

                const sendAnnouncement = async () => {
                    try {
                        const msg = await channel.send({ content: mentionText || undefined, embeds: [embed] });
                        LAST_ANNOUNCEMENT.messageId = msg.id;
                        LAST_ANNOUNCEMENT.channelId = channel.id;
                    } catch (e) {
                        console.error('Error sending announcement:', e);
                    }
                };

                if (delay > 0) {
                    setTimeout(sendAnnouncement, delay * 1000);
                    await interaction.followUp({ content: `⏳ Announcement akan dikirim dalam ${delay}s...`, flags: 64 });
                } else {
                    await sendAnnouncement();
                    await interaction.followUp({ content: '✅ Announcement berhasil dibuat!', flags: 64 });
                }
            }
        }
    } catch (err) {
        console.error('Interaction handler error', err);
    }
});


function loadTransaksi() {
    if (!fs.existsSync(TRANSAKSI_FILE)) {
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(TRANSAKSI_FILE, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveTransaksi(data) {
    fs.writeFileSync(TRANSAKSI_FILE, JSON.stringify(data, null, 4));
}

function loadLeaderboard() {
    if (!fs.existsSync(LEADERBOARD_FILE)) {
        fs.writeFileSync(LEADERBOARD_FILE, '{}');
    }
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
}

function saveLeaderboard(data) {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 4));
}

function loadStickyMessages() {
    if (!fs.existsSync(STICKY_FILE)) {
        fs.writeFileSync(STICKY_FILE, '{}');
        return {};
    }
    try {
        return JSON.parse(fs.readFileSync(STICKY_FILE, 'utf8')) || {};
    } catch (e) {
        return {};
    }
}

function saveStickyMessages(data) {
    fs.writeFileSync(STICKY_FILE, JSON.stringify(data, null, 4));
}

function createStickyEmbed(content) {
    return new EmbedBuilder()
        .setTitle('<a:Kawai:1504851393507496090> ZaneXyuu Studio - Message')
        .setDescription(content)
        .setColor(0x27b4f8)
        .setThumbnail('https://cdn.discordapp.com/attachments/1374335784613843000/1504522284789010524/pp.png?ex=6a074b11&is=6a05f991&hm=2e73ce5c0ce99d9fcb7dd03a915bb81880063f3f8f9cd79ae998ad3127acb52c')
        .setFooter({ text: 'Made by ZaneXyuu Studio', iconURL: 'https://cdn.discordapp.com/emojis/1273384825801412638.gif?size=128' });
}

async function setStickyMessage(channel, content) {
    const channelId = channel.id;
    const existing = stickyMessages[channelId];
    if (existing && existing.messageId) {
        try {
            const existingMessage = await channel.messages.fetch(existing.messageId);
            if (existingMessage && existingMessage.deletable) {
                await existingMessage.delete();
            }
        } catch (error) {
        }
    }

    const sentMessage = await channel.send(content);
    stickyMessages[channelId] = {
        messageId: sentMessage.id,
        content
    };
    saveStickyMessages(stickyMessages);
    console.log(`[Sticky] Set sticky for channel ${channelId} -> message ${sentMessage.id}`);
    return sentMessage;
}

async function removeStickyMessage(channel) {
    const channelId = channel.id;
    const existing = stickyMessages[channelId];
    if (!existing) return false;
    if (existing.messageId) {
        try {
            const existingMessage = await channel.messages.fetch(existing.messageId);
            if (existingMessage && existingMessage.deletable) {
                await existingMessage.delete();
            }
        } catch (error) {
        }
    }
    delete stickyMessages[channelId];
    saveStickyMessages(stickyMessages);
    return true;
}

const stickyMessages = loadStickyMessages();
const pendingStickyUsers = new Map();
const pendingPayments = new Map();
const PAYMENT_RBXM_FILE = path.join(__dirname, 'Club Kit ZaneXyuu V3 Updated.rbxm');
const RETRY_LOGIN_DELAY = 10000;

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function registerGlobalHandlers() {
    process.on('unhandledRejection', reason => {
        console.error('[Unhandled Rejection]', reason);
    });

    process.on('uncaughtException', error => {
        console.error('[Uncaught Exception]', error);
    });

    process.on('uncaughtExceptionMonitor', error => {
        console.error('[Uncaught Exception Monitor]', error);
    });

    process.on('warning', warning => {
        if (warning.name === 'DeprecationWarning' && warning.message.includes('ready event has been renamed to clientReady')) {
            return;
        }
        console.warn('[Process Warning]', warning.stack || warning);
    });
}

async function loginBot(token) {
    while (true) {
        try {
            await client.login(token);
            console.log('[Bot Login] Berhasil login ke Discord.');
            break;
        } catch (error) {
            console.error('[Bot Login] Gagal login, mencoba lagi dalam 10 detik...', error);
            await wait(RETRY_LOGIN_DELAY);
        }
    }
}

registerGlobalHandlers();

function parseNominal(input) {
    if (typeof input === 'number' && Number.isFinite(input)) {
        return Math.round(input);
    }
    if (typeof input !== 'string') return null;
    const normalized = input.trim().toUpperCase();
    let value = normalized.replace(/\./g, '').replace(/,/g, '');

    if (value.endsWith('K')) {
        const number = parseFloat(value.slice(0, -1));
        if (Number.isNaN(number)) return null;
        return Math.round(number * 1000);
    }

    if (value.endsWith('M')) {
        const number = parseFloat(value.slice(0, -1));
        if (Number.isNaN(number)) return null;
        return Math.round(number * 1000000);
    }

    const number = parseInt(value, 10);
    return Number.isNaN(number) ? null : number;
}

async function updateSpenderRole(member, totalSpent) {
    let targetRoleId = null;
    for (const [roleId, minAmount] of Object.entries(SPENDER_ROLES)) {
        if (totalSpent >= minAmount) {
            targetRoleId = roleId;
            break;
        }
    }

    if (!targetRoleId) return;

    for (const roleId of Object.keys(SPENDER_ROLES)) {
        const role = member.guild.roles.cache.get(roleId);
        if (role && member.roles.cache.has(roleId) && roleId !== targetRoleId) {
            await member.roles.remove(role);
        }
    }

    const targetRole = member.guild.roles.cache.get(targetRoleId);
    if (targetRole && !member.roles.cache.has(targetRoleId)) {
        await member.roles.add(targetRole);
    }
}

// Modals
class JasaServiceModal {
    static create() {
        const modal = new ModalBuilder()
            .setCustomId('jasa_service_modal')
            .setTitle('Format Jasa Service');

        const usernameInput = new TextInputBuilder()
            .setCustomId('username')
            .setLabel('Username Discord')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(50);

        const serviceInput = new TextInputBuilder()
            .setCustomId('service')
            .setLabel('Jasa yang ingin digunakan')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Format: Fix bug / pasang system / dll.')
            .setRequired(true)
            .setMaxLength(200);

        const firstActionRow = new ActionRowBuilder().addComponents(usernameInput);
        const secondActionRow = new ActionRowBuilder().addComponents(serviceInput);

        modal.addComponents(firstActionRow, secondActionRow);
        return modal;
    }
}

class JasaSetupDCModal {
    static create() {
        const modal = new ModalBuilder()
            .setCustomId('jasa_setup_dc_modal')
            .setTitle('Format Jasa Setup DC');

        const usernameInput = new TextInputBuilder()
            .setCustomId('username')
            .setLabel('Username Discord')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        const serviceInput = new TextInputBuilder()
            .setCustomId('service')
            .setLabel('Jasa Setup DC')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Nama Server Discord\nKeterangan\n\nContoh:\nServer tema store\nRole, verifikasi member, bot musik, dll')
            .setRequired(true)
            .setMaxLength(200);

        const firstActionRow = new ActionRowBuilder().addComponents(usernameInput);
        const secondActionRow = new ActionRowBuilder().addComponents(serviceInput);

        modal.addComponents(firstActionRow, secondActionRow);
        return modal;
    }
}

class JasaCustomBotModal {
    static create() {
        const modal = new ModalBuilder()
            .setCustomId('jasa_custom_bot_modal')
            .setTitle('Format Jasa Custom Bot');

        const usernameInput = new TextInputBuilder()
            .setCustomId('username')
            .setLabel('Username Discord')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(20);

        const serviceInput = new TextInputBuilder()
            .setCustomId('service')
            .setLabel('Jasa Custom Bot')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Contoh: bot ecommerce dengan payment gateway, auto role, shop system, dashboard admin')
            .setRequired(true)
            .setMaxLength(200);

        const firstActionRow = new ActionRowBuilder().addComponents(usernameInput);
        const secondActionRow = new ActionRowBuilder().addComponents(serviceInput);

        modal.addComponents(firstActionRow, secondActionRow);
        return modal;
    }
}

class CustomerVouchModal {
    constructor(staffMention, produk, nominal) {
        this.staffMention = staffMention;
        this.produk = produk;
        this.nominal = nominal;

        const customId = `customer_vouch_modal_${Date.now()}`;
        vouchData.set(customId, { staffMention, produk, nominal });

        this.modal = new ModalBuilder()
            .setCustomId(customId)
            .setTitle('Submit Testimoni');

        const ratingInput = new TextInputBuilder()
            .setCustomId('rating')
            .setLabel('Rating (1-5)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('5')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(1);

        const komentarInput = new TextInputBuilder()
            .setCustomId('komentar')
            .setLabel('Komentar')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Fast respon, mantap!')
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(ratingInput);
        const secondActionRow = new ActionRowBuilder().addComponents(komentarInput);

        this.modal.addComponents(firstActionRow, secondActionRow);
    }

    getModal() {
        return this.modal;
    }
}

class StaffVouchModal {
    static create() {
        const modal = new ModalBuilder()
            .setCustomId('staff_vouch_modal')
            .setTitle('Format Vouch (Staff Only)');

        const produkInput = new TextInputBuilder()
            .setCustomId('produk')
            .setLabel('Produk yang dibeli')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Contoh: 1000 Robux')
            .setRequired(true);

        const nominalInput = new TextInputBuilder()
            .setCustomId('nominal')
            .setLabel('Nominal')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Contoh: 150.000')
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(produkInput);
        const secondActionRow = new ActionRowBuilder().addComponents(nominalInput);

        modal.addComponents(firstActionRow, secondActionRow);
        return modal;
    }
}

class CloseTicketModal {
    static create() {
        const modal = new ModalBuilder()
            .setCustomId('close_ticket_modal')
            .setTitle('Tutup Ticket');

        const reasonInput = new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const totalInput = new TextInputBuilder()
            .setCustomId('total')
            .setLabel('Total Harga')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(reasonInput);
        const secondActionRow = new ActionRowBuilder().addComponents(totalInput);

        modal.addComponents(firstActionRow, secondActionRow);
        return modal;
    }
}

// Views
class TicketView {
    static create() {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('order_club_kit')
                    .setLabel('Order Club Kit')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('<a:RS:1504384160821674005>'),
                new ButtonBuilder()
                    .setCustomId('jasa_service')
                    .setLabel('Jasa Service')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('<a:Thunder:1277088364570607616>'),
                new ButtonBuilder()
                    .setCustomId('jasa_setup_dc')
                    .setLabel('Jasa Setup DC')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('<a:Discord:1504387168179720242>'),
                new ButtonBuilder()
                    .setCustomId('jasa_custom_bot')
                    .setLabel('Jasa Custom Bot')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('<a:Bot:1288897921328218124>')
            );

        return row;
    }
}

class CloseTicketButton {
    static create() {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('ticket_close')
                    .setLabel('Tutup Ticket')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🔒')
            );

        return row;
    }
}

class CustomerVouchTrigger {
    constructor(staffMention, produk, nominal, channelId) {
        this.staffMention = staffMention;
        this.produk = produk;
        this.nominal = nominal;
        this.channelId = channelId;

        const customId = `btn_vouch_customer_${Date.now()}`;
        vouchData.set(customId, { staffMention, produk, nominal });

        this.row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(customId)
                    .setLabel('Submit Vouch')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('✍️')
            );
    }

    getRow() {
        return this.row;
    }
}

class StaffInputTrigger {
    static create() {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('staff_input')
                    .setLabel('Isi Data Vouch')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📝')
            );

        return row;
    }
}

class VerifyPanelButton {
    static create() {
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('verify')
                    .setLabel('Verification Here')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('<a:Verify:1470136337632985199>'),
                new ButtonBuilder()
                    .setCustomId('verification_info')
                    .setLabel('ZaneXyuu Studio Verification System')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('<a:Owners:1276242227827441685>')
            );

        return row;
    }
}

const PANEL_LOG_NAMES = {
    'order club kit': '<a:RS:1504384160821674005> Order Club Kit',
    'jasa service': '<a:Thunder:1277088364570607616> Jasa Service',
    'jasa setup dc': '<a:Discord:1504387168179720242> Jasa Setup DC',
    'jasa custom bot': '<a:Bot:1288897921328218124> Jasa Custom Bot',
};

async function createTicket(interaction, tipe, data = null) {
    const guild = interaction.guild;
    const categoryId = CATEGORY_ID[GUILD_ID.indexOf(guild.id)];
    const category = guild.channels.cache.get(categoryId);

    if (!category) {
        const message = interaction.replied || interaction.deferred ? 'followup' : 'reply';
        return await interaction[message]({ content: '⚠️ Kategori tidak ditemukan atau tidak valid. Silakan hubungi admin.', flags: 64 });
    }

    if (category.children.cache.size >= 50) {
        const message = interaction.replied || interaction.deferred ? 'followup' : 'reply';
        return await interaction[message]({ content: '⚠️ Maaf, kategori ticket sudah penuh. Silakan hubungi admin.', flags: 64 });
    }

    const overwrites = [
        {
            id: guild.id,
            deny: ['ViewChannel'],
        },
        {
            id: interaction.user.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'],
        },
    ];

    try {
        const ticketNumber = getNextTicketNumber();
        const ticketChannel = await guild.channels.create({
            name: `ticket-${ticketNumber.toString().padStart(4, '0')}`,
            type: 0, 
            parent: categoryId,
            permissionOverwrites: overwrites,
            topic: `${interaction.user.id}|${tipe}`
        });

        const embed = new EmbedBuilder()
            .setTitle('📩 Ticket Dibuat')
            .setColor(0xE4F1F5)
            .addFields(
                { name: 'User', value: interaction.user.toString(), inline: false },
                { name: 'Tipe', value: tipe.charAt(0).toUpperCase() + tipe.slice(1), inline: false }
            );

        if (data) {
            for (const [key, value] of Object.entries(data)) {
                embed.addFields({ name: key, value: value, inline: false });
            }
        }

        await ticketChannel.send({ content: interaction.user.toString(), embeds: [embed] });
        await ticketChannel.send({ content: 'Terima kasih telah membuat ticket. Silakan tunggu respon dari owner ZaneXyuu Studio.', components: [CloseTicketButton.create()] });

        for (const logChannelId of LOG_CHANNEL_IDS) {
            const logChannel = guild.channels.cache.get(logChannelId);
            if (logChannel) {
                const panel = PANEL_LOG_NAMES[tipe] || '❓ Unknown Panel';

                const logEmbed = new EmbedBuilder()
                    .setTitle('Ticket Created')
                    .setColor(0x07B7F9)
                    .addFields(
                        { name: 'Ticket', value: `🎟️ Ticket-${ticketNumber.toString().padStart(4, '0')}`, inline: false },
                        { name: 'Action', value: '🔓 Created', inline: false },
                        { name: 'Panel', value: panel, inline: false },
                        { name: 'Username', value: `👤 ${interaction.user.username}`, inline: false }
                    )
                    .setImage('https://cdn.discordapp.com/attachments/1374335784613843000/1504523490886156343/banner.png?ex=6a074c30&is=6a05fab0&hm=face41adbf77fb71bb666e3e46f8bf9a31f35adcab664d8649f4ade797c0618c')
                    .setThumbnail('https://cdn.discordapp.com/attachments/1374335784613843000/1504522284789010524/pp.png?ex=6a074b11&is=6a05f991&hm=2e73ce5c0ce99d9fcb7dd03a915bb81880063f3f8f9cd79ae998ad3127acb52c')
                    .setFooter({ text: 'Made by ZaneXyuu Studio', iconURL: 'https://cdn.discordapp.com/emojis/1273384825801412638.gif?size=512' })
                    .setTimestamp();

                await logChannel.send({ embeds: [logEmbed] });
            }
        }

        const responseMethod = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
        await interaction[responseMethod]({ content: `<a:Verify:1470136337632985199> Ticket kamu sudah dibuat: ${ticketChannel}`, flags: 64 });

    } catch (e) {
        const responseMethod = interaction.replied || interaction.deferred ? 'followUp' : 'reply';
        await interaction[responseMethod]({ content: `⚠️ Terjadi kesalahan saat membuat ticket: ${e}`, flags: 64 });
    }
}

const ACTIVITIES = [
    { type: ActivityType.Playing, name: 'ZaneXyuu Studio', status: PresenceUpdateStatus.DoNotDisturb },
    { type: ActivityType.Listening, name: 'Music', status: PresenceUpdateStatus.Online },
    { type: ActivityType.Watching, name: 'Youtube', status: PresenceUpdateStatus.Idle },
];
const ACTIVITY_INTERVAL = 1800;

async function rotateActivity() {
    let i = 0;
    while (client.isReady()) {
        const activityData = ACTIVITIES[i % ACTIVITIES.length];
        await client.user.setPresence({
            activities: [{ type: activityData.type, name: activityData.name }],
            status: activityData.status
        });
        i++;
        await new Promise(resolve => setTimeout(resolve, ACTIVITY_INTERVAL * 1000));
    }
}

let readyHandled = false;
async function onBotReady() {
    if (readyHandled) return;
    readyHandled = true;
    console.log(`✅ Bot ${client.user.username} sudah online!`);
    rotateActivity();
    try {
        await registerSlashCommands();
    } catch (error) {
        console.error('[Slash Command Registration Error]', error);
    }
}

client.once('clientReady', onBotReady);

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'order_club_kit') {
            await createTicket(interaction, 'order club kit');
        } else if (interaction.customId === 'jasa_service') {
            await interaction.showModal(JasaServiceModal.create());
        } else if (interaction.customId === 'jasa_setup_dc') {
            await interaction.showModal(JasaSetupDCModal.create());
        } else if (interaction.customId === 'jasa_custom_bot') {
            await interaction.showModal(JasaCustomBotModal.create());
        } else if (interaction.customId === 'ticket_close') {
            if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                return await interaction.reply({ content: '⚠️ Kamu tidak punya izin.', flags: 64 });
            }
            await interaction.showModal(CloseTicketModal.create());
        } else if (interaction.customId.startsWith('btn_vouch_customer_')) {
            const data = vouchData.get(interaction.customId);
            if (!data) return;
            const modal = new CustomerVouchModal(data.staffMention, data.produk, data.nominal);
            await interaction.showModal(modal.getModal());
        } else if (interaction.customId === 'staff_input') {
            if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                return await interaction.reply({ content: '⚠️ Hanya staff yang bisa mengisi ini.', flags: 64 });
            }
            await interaction.showModal(StaffVouchModal.create());
        } else if (interaction.customId === 'verify') {
            const role = interaction.guild.roles.cache.get(VERIFY_ROLE_ID);
            if (!role) {
                return await interaction.reply({ content: '⚠️ Role verifikasi tidak ditemukan.', flags: 64 });
            }

            const member = interaction.member;
            if (member.roles.cache.has(VERIFY_ROLE_ID)) {
                return await interaction.reply({ content: '<a:Verify:1470136337632985199> Kamu sudah terverifikasi.', flags: 64 });
            }

            await member.roles.add(role, 'User Verified');
            await interaction.reply({ content: '<a:Verify:1470136337632985199> Verifikasi berhasil!', flags: 64 });
        } else if (interaction.customId === 'verification_info') {
            await interaction.deferUpdate();
        }
    } else if (interaction.isModalSubmit()) {
        if (interaction.customId === 'order_club_kit_modal') {
            await interaction.deferReply({ flags: 64 });
            const username = interaction.fields.getTextInputValue('username');
            const item = interaction.fields.getTextInputValue('item');
            await createTicket(interaction, 'order club kit', { 'Username Roblox': username, 'Nama Item Ingame': item });
        } else if (interaction.customId === 'jasa_service_modal') {
            await interaction.deferReply({ flags: 64 });
            const username = interaction.fields.getTextInputValue('username');
            const service = interaction.fields.getTextInputValue('service');
            await createTicket(interaction, 'jasa service', { 'Username Discord': username, 'Jasa yang ingin digunakan': service });
        } else if (interaction.customId === 'jasa_setup_dc_modal') {
            await interaction.deferReply({ flags: 64 });
            const username = interaction.fields.getTextInputValue('username');
            const service = interaction.fields.getTextInputValue('service');
            await createTicket(interaction, 'jasa setup dc', { 'Username Discord': username, 'Jasa Setup DC': service });
        } else if (interaction.customId === 'jasa_custom_bot_modal') {
            await interaction.deferReply({ flags: 64 });
            const username = interaction.fields.getTextInputValue('username');
            const service = interaction.fields.getTextInputValue('service');
            await createTicket(interaction, 'jasa custom bot', { 'Username Discord': username, 'Jasa Custom Bot': service });
        } else if (interaction.customId.startsWith('customer_vouch_modal_')) {
            const data = vouchData.get(interaction.customId);
            if (!data) return;

            await interaction.deferReply({ ephemeral: false });

            const rating = interaction.fields.getTextInputValue('rating');
            const komentar = interaction.fields.getTextInputValue('komentar');

            let stars = '⭐⭐⭐⭐⭐';
            try {
                stars = '⭐'.repeat(parseInt(rating));
            } catch {}

            let buyerAvatar = interaction.user.displayAvatarURL({ dynamic: true, size: 512 });
            if (interaction.channel.topic && interaction.channel.topic.includes('|')) {
                const ownerId = interaction.channel.topic.split('|')[0].trim();
                const owner = interaction.guild.members.cache.get(ownerId);
                if (owner) {
                    buyerAvatar = owner.displayAvatarURL({ dynamic: true, size: 512 });
                }
            }

            const embed = new EmbedBuilder()
                .setTitle('<a:Verify:1470136337632985199> VOUCH RECEIVED')
                .setColor(0x2ECC71)
                .addFields(
                    { name: 'Nominal', value: `Rp ${data.nominal}`, inline: true },
                    { name: 'Produk', value: data.produk, inline: true },
                    { name: 'Buyer', value: interaction.user.toString(), inline: true },
                    { name: 'Handled by', value: data.staffMention, inline: true },
                    { name: 'Vouched by', value: interaction.user.toString(), inline: true },
                    { name: 'Rating', value: stars, inline: true },
                    { name: 'Komentar', value: komentar, inline: false }
                );

            let sourceName = 'Unknown Panel';
            if (interaction.channel.topic && interaction.channel.topic.includes('|')) {
                const panelType = interaction.channel.topic.split('|')[1].trim();
                if (panelType === 'order club kit') sourceName = '<a:RS:1504384160821674005> Order Club Kit';
                else if (panelType === 'jasa custom bot') sourceName = '<a:Bot:1288897921328218124> Jasa Custom Bot';
                else if (panelType === 'jasa setup dc') sourceName = '<a:Discord:1504387168179720242> Jasa Setup DC';
                else if (panelType === 'jasa service') sourceName = '<a:Thunder:1277088364570607616> Jasa Service';
                else sourceName = panelType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
            }

            embed.addFields(
                { name: 'Ticket ID', value: interaction.channel.name.replace('ticket-', ''), inline: true },
                { name: 'Source', value: sourceName, inline: true }
            )
            .setThumbnail(buyerAvatar)
            .setFooter({ text: 'ZaneXyuu Studio', iconURL: interaction.guild.iconURL() });

            const logChannel = interaction.guild.channels.cache.get(VOUCH_CHANNEL_ID[0]);
            if (logChannel) {
                await logChannel.send({ embeds: [embed] });
            }
            await interaction.editReply({ content: `<a:Verify:1470136337632985199> Vouch berhasil dikirim ke ${logChannel}!` });

            vouchData.delete(interaction.customId);
        } else if (interaction.customId === 'staff_vouch_modal') {
            const produk = interaction.fields.getTextInputValue('produk');
            const nominal = interaction.fields.getTextInputValue('nominal');

            const topic = interaction.channel.topic;
            let buyerMention = 'Pelanggan';
            let buyerAvatar = null;
            if (topic) {
                const ownerId = topic.split('|')[0];
                const owner = interaction.guild.members.cache.get(ownerId);
                if (owner) {
                    buyerMention = owner.toString();
                    buyerAvatar = owner.displayAvatarURL({ dynamic: true, size: 512 });
                }
            }

            const embed = new EmbedBuilder()
                .setTitle('🌟 Berikan Vouch!')
                .setDescription(
                    `Terima kasih ${buyerMention} telah berbelanja di **ZaneXyuu Studio**!\n\n` +
                    `**Detail Transaksi:**\n` +
                    `📦 **Produk:** ${produk}\n` +
                    `💰 **Nominal:** Rp ${nominal}\n\n` +
                    `Silakan klik tombol di bawah untuk memberikan rating dan komentar.`
                )
                .setColor(0x00FFD5)
                .setThumbnail(buyerAvatar || 'https://cdn.discordapp.com/attachments/1374335784613843000/1504514958950666381/pp.png?ex=6a07443e&is=6a05f2be&hm=697c8482c8b2f6181a1670f503d24c8f1eb34c4fb020ddf16136281604f20689');

            const vouchTrigger = new CustomerVouchTrigger(interaction.user.toString(), produk, nominal, interaction.channel.id);
            await interaction.channel.send({ content: `Halo ${buyerMention}!`, embeds: [embed], components: [vouchTrigger.getRow()] });
            await interaction.reply({ content: '<a:Verify:1470136337632985199> Berhasil mengirim panel vouch.', flags: 64 });

            const messages = await interaction.channel.messages.fetch({ limit: 10 });
            for (const msg of messages.values()) {
                if (msg.components.length > 0 && msg.components[0].components.length > 0 && msg.components[0].components[0].customId === 'staff_input') {
                    await msg.delete();
                    break;
                }
            }
        } else if (interaction.customId === 'close_ticket_modal') {
            const reason = interaction.fields.getTextInputValue('reason');
            const total = interaction.fields.getTextInputValue('total');

            const guild = interaction.guild;
            const channel = interaction.channel;
            const topic = channel.topic;
            const tipe = topic ? topic.split('|')[1] : 'unknown';
            const panel = PANEL_LOG_NAMES[tipe] || '❓ Unknown Panel';

            let ticketOwner = null;
            if (topic && topic.includes('|')) {
                const ticketOwnerId = topic.split('|')[0];
                ticketOwner = guild.members.cache.get(ticketOwnerId);
            }

            const username = ticketOwner ? ticketOwner.user.username : 'Unknown User';

            await interaction.reply({ content: '🔒 Ticket ditutup. Channel akan dihapus dalam 5 detik...', flags: 64 });
            await channel.send('🛑 Ticket ini telah ditutup.');

            setTimeout(async () => {
                await channel.delete();
            }, 5000);

            for (const logChannelId of LOG_CHANNEL_IDS) {
                const logChannel = guild.channels.cache.get(logChannelId);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setTitle('Ticket Closed')
                        .setColor(0xFE0909)
                        .addFields(
                            { name: 'Ticket', value: `🎟️ ${channel.name}`, inline: false },
                            { name: 'Action', value: '🔒 Closed', inline: false },
                            { name: 'Panel', value: panel, inline: false },
                            { name: 'Username', value: `👤 ${username}`, inline: false },
                            { name: 'Reason', value: `📝 ${reason}`, inline: false },
                            { name: 'Total Harga', value: `💰 Rp ${total}`, inline: false }
                        )
                        .setImage('https://cdn.discordapp.com/attachments/1374335784613843000/1504523490886156343/banner.png?ex=6a074c30&is=6a05fab0&hm=face41adbf77fb71bb666e3e46f8bf9a31f35adcab664d8649f4ade797c0618c')
                        .setThumbnail('https://cdn.discordapp.com/attachments/1374335784613843000/1504522284789010524/pp.png?ex=6a074b11&is=6a05f991&hm=2e73ce5c0ce99d9fcb7dd03a915bb81880063f3f8f9cd79ae998ad3127acb52c')
                        .setFooter({ text: 'Made by ZaneXyuu Studio', iconURL: 'https://cdn.discordapp.com/emojis/1273384825801412638.gif?size=512' })
                        .setTimestamp();

                    await logChannel.send({ embeds: [logEmbed] });
                }
            }
        }
    } else if (interaction.isChatInputCommand()) {
        // Handle slash commands
        if (interaction.commandName === 'transaksi') {
            if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                return await interaction.reply({ content: '⚠️ Kamu tidak punya izin untuk menggunakan perintah ini.', flags: 64 });
            }

            const member = interaction.options.getMember('member');
            const jumlah = interaction.options.getString('jumlah');

            try {
                const jumlahInt = parseInt(jumlah.replace(/\./g, '').replace(/,/g, ''));
                const data = loadTransaksi();
                const userId = member.id;
                data[userId] = (data[userId] || 0) + jumlahInt;
                saveTransaksi(data);

                await interaction.reply({
                    content: `<a:Verify:1470136337632985199> Transaksi sebesar \`Rp ${jumlahInt.toLocaleString()}\` telah ditambahkan untuk ${member}.\nTotal sekarang: \`Rp ${data[userId].toLocaleString()}\``,
                    flags: 64
                });
            } catch (e) {
                await interaction.reply({ content: '❌ Format jumlah tidak valid. Gunakan angka seperti `100.000`.', flags: 64 });
            }
        } else if (interaction.commandName === 'total_transaksi') {
            const data = loadTransaksi();
            const userId = interaction.user.id;
            const total = data[userId] || 0;

            const embed = new EmbedBuilder()
                .setTitle('💰 Total Transaksi Kamu')
                .setColor(0x00ffcc)
                .addFields(
                    { name: 'Nama', value: interaction.user.username, inline: true },
                    { name: 'Total', value: `Rp ${total.toLocaleString()}`, inline: true }
                );

            await interaction.reply({ embeds: [embed], flags: 64 });
        } else if (interaction.commandName === 'add_user') {
            if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                return await interaction.reply({ content: '⚠️ Kamu tidak punya izin.', flags: 64 });
            }

            const member = interaction.options.getMember('member');
            const channel = interaction.channel;

            if (!channel.name.startsWith('ticket-')) {
                return await interaction.reply({ content: '⚠️ Command ini hanya bisa digunakan di channel ticket.', flags: 64 });
            }

            await channel.permissionOverwrites.edit(member, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true
            });

            await interaction.reply({
                content: `<a:Verify:1470136337632985199> ${member} berhasil ditambahkan ke ticket ini.`,
                ephemeral: false
            });
        } else if (interaction.commandName === 'add_spend') {
            if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                return await interaction.reply({ content: '⚠️ Kamu tidak punya izin.', flags: 64 });
            }

            const user = interaction.options.getMember('user');
            const nominalOption = interaction.options.data.find(option => option.name === 'nominal');
            let nominalInput = null;
            if (nominalOption) {
                nominalInput = typeof nominalOption.value === 'number' ? nominalOption.value.toString() : nominalOption.value;
            }
            const nominal = parseNominal(nominalInput);

            if (nominal === null || nominal <= 0) {
                return await interaction.reply({ content: '❌ Format nominal tidak valid. Contoh: `125K` atau `125.000`.', flags: 64 });
            }

            const data = loadLeaderboard();
            const userId = user.id;
            data[userId] = (data[userId] || 0) + nominal;
            saveLeaderboard(data);

            await updateSpenderRole(user, data[userId]);

            const formattedNominal = `Rp ${nominal.toLocaleString()}`.replace(/,/g, '.');
            const totalNominal = `Rp ${data[userId].toLocaleString()}`.replace(/,/g, '.');

            await interaction.reply({
                content: `<a:Verify:1470136337632985199> Berhasil menambahkan **${formattedNominal}** ke ${user}.\nTotal belanja sekarang: **${totalNominal}**`,
                ephemeral: false
            });
        } else if (interaction.commandName === 'remove_spend') {
            if (!ADMIN_USER_IDS.includes(interaction.user.id)) {
                return await interaction.reply({ content: '⚠️ Kamu tidak punya izin.', flags: 64 });
            }

            const user = interaction.options.getMember('user');
            const nominalOption = interaction.options.data.find(option => option.name === 'nominal');
            let nominalInput = null;
            if (nominalOption) {
                nominalInput = typeof nominalOption.value === 'number' ? nominalOption.value.toString() : nominalOption.value;
            }
            const nominal = parseNominal(nominalInput);

            if (nominal === null || nominal <= 0) {
                return await interaction.reply({ content: '❌ Format nominal tidak valid. Contoh: `125K` atau `125.000`.', flags: 64 });
            }

            const data = loadLeaderboard();
            const userId = user.id;
            data[userId] = Math.max((data[userId] || 0) - nominal, 0);
            saveLeaderboard(data);

            await updateSpenderRole(user, data[userId]);

            const formattedNominal = `Rp ${nominal.toLocaleString()}`.replace(/,/g, '.');
            const totalNominal = `Rp ${data[userId].toLocaleString()}`.replace(/,/g, '.');

            await interaction.reply({
                content: `<a:Verify:1470136337632985199> Berhasil mengurangi **${formattedNominal}** dari ${user}.\nTotal belanja sekarang: **${totalNominal}**`,
                ephemeral: false
            });
        } else if (interaction.commandName === 'leaderboard') {
            const data = loadLeaderboard();
            if (Object.keys(data).length === 0) {
                return await interaction.reply({ content: 'Belum ada data top spender.', flags: 64 });
            }

            const sortedSpenders = Object.entries(data).sort((a, b) => b[1] - a[1]);
            const embed = new EmbedBuilder()
                .setTitle('🏆 Top Spenders ZaneXyuu Studio')
                .setColor(0x14D2FA);

            let description = '';
            let userRank = 'Belum masuk rank';
            let userTotal = 'Rp 0';

            for (let i = 0; i < sortedSpenders.length; i++) {
                const [userId, amount] = sortedSpenders[i];
                const rank = i + 1;
                const formattedAmount = `Rp ${amount.toLocaleString()}`.replace(/,/g, '.');

                if (userId === interaction.user.id) {
                    userRank = `#${rank}`;
                    userTotal = formattedAmount;
                }

                if (rank <= 10) {
                    let prefix = `**#${rank}**`;
                    if (rank === 1) prefix = '🥇';
                    else if (rank === 2) prefix = '🥈';
                    else if (rank === 3) prefix = '🥉';

                    description += `${prefix} <@${userId}> — 💸 **${formattedAmount}**\n`;
                }
            }

            embed.setDescription(description);
            embed.setFooter({ text: `🎈 Rank kamu: ${userRank} | Total: ${userTotal}` });

            await interaction.reply({ embeds: [embed] });
        } else if (interaction.commandName === 'generate') {
            const placeId = interaction.options.getString('id');
            const apiKey = 'demon_704b65703b4618318f08bfccd82eac0d';
            const apiUrl = `https://demonbypass.c5.lol/api/server?id=${encodeURIComponent(placeId)}&apikey=${encodeURIComponent(apiKey)}`;

            await interaction.deferReply();

            try {
                let gameName = 'Unknown Game';
                try {
                    const placeResponse = await fetch(`https://www.roblox.com/games/${placeId}`, {
                        redirect: 'manual',
                        headers: { 'User-Agent': 'Mozilla/5.0' }
                    });
                    if (placeResponse.status === 301 || placeResponse.status === 302) {
                        const redirectUrl = placeResponse.headers.get('location');
                        if (redirectUrl) {
                            const parts = redirectUrl.split('/games/');
                            if (parts[1]) {
                                const gameSlug = parts[1].split('/').pop();
                                if (gameSlug) {
                                    gameName = gameSlug.replace(/-/g, ' ');
                                }
                            }
                        }
                    }
                } catch (e) {
                }

                const response = await fetch(apiUrl);
                if (!response.ok) {
                    return await interaction.editReply({ content: '❌ Generate Failed' });
                }

                const result = await response.json();
                if (!result.success) {
                    return await interaction.editReply({ content: '❌ Generate Failed' });
                }

                const embed = new EmbedBuilder()
                    .setTitle('<a:Verify:1470136337632985199> ZaneXyuu Studio')
                    .setColor(0x00ffcc)
                    .addFields(
                        { name: 'Game', value: gameName, inline: false },
                        { name: 'Private Server', value: result.server || 'Tidak ada link server', inline: false }
                    )
                    .setFooter({ text: 'Made by ZaneXyuu Studio' });

                try {
                    await interaction.user.send({ embeds: [embed] });
                    await interaction.editReply({ content: '<a:Verify:1470136337632985199> Generate Success — please check your DMs' });
                } catch (dmError) {
                    await interaction.editReply({ content: '<a:Verify:1470136337632985199> Generate Success — please check your DMs, tetapi DM gagal terkirim. Pastikan DM dari server ini diaktifkan.' });
                }
            } catch (error) {
                await interaction.editReply({ content: '❌ Generate Failed' });
            }
        }
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot) return;

    const normalized = message.content.trim();
    const channelId = message.channel.id;

    const supportedAttachments = [...message.attachments.values()].filter(att => isSupportedAudioAttachment(att));
    const unsupportedAudioAttachments = [...message.attachments.values()].filter(att => looksLikeAudioAttachment(att) && !isSupportedAudioAttachment(att));
    const audioChannelRestricted = Array.isArray(AUDIO_REMIX_CHANNEL_IDS) && AUDIO_REMIX_CHANNEL_IDS.length > 0 && !AUDIO_REMIX_CHANNEL_IDS.includes(channelId);

    if (audioChannelRestricted && (supportedAttachments.length > 0 || unsupportedAudioAttachments.length > 0)) {
        return;
    }

    if (unsupportedAudioAttachments.length > 0 && supportedAttachments.length === 0) {
        return await message.reply({
            content: '❌ Hanya file audio dengan ekstensi .mp3, .ogg, .flac, dan .wav yang didukung. Silakan upload ulang file yang sesuai.',
            allowedMentions: { repliedUser: false }
        });
    }

    if (supportedAttachments.length > 0) {
        const effectSettings = parseAudioEffectSettings(normalized);
        await processAttachmentAudio(message, supportedAttachments[0], null, effectSettings);
        return;
    }

    const lower = normalized.toLowerCase();
    if (lower === '?effect-format' || lower === '?audio-format') {
        return await message.reply({
            content: AUDIO_EFFECT_FORMAT_TEMPLATE,
            allowedMentions: { repliedUser: false }
        });
    }

    const activeSticky = stickyMessages[channelId];

    const startMatch = normalized.match(/^\?start(?:\s+([\s\S]+))?$/i);
    if (startMatch) {
        if (!ADMIN_USER_IDS.includes(message.author.id)) {
            return await message.reply('⚠️ Kamu tidak punya izin untuk menjalankan perintah ini.');
        }

        await message.delete().catch(() => {});
        const stickyText = startMatch[1] ? startMatch[1].trim() : '';
        if (stickyText) {
            await setStickyMessage(message.channel, stickyText);
            const confirmation = await message.channel.send('✅ Sticky message berhasil diaktifkan sebagai embed. Pesan bot akan selalu muncul di paling bawah.');
            setTimeout(() => confirmation.delete().catch(() => {}), 5000);
            return;
        }

        pendingStickyUsers.set(channelId, message.author.id);
        return await message.channel.send('💬 Kirim pesan yang ingin dijadikan sticky sekarang.');
    }

    if (pendingStickyUsers.get(channelId) === message.author.id) {
        pendingStickyUsers.delete(channelId);
        await setStickyMessage(message.channel, normalized);
        await message.delete().catch(() => {});
        const confirmation2 = await message.channel.send('✅ Sticky message berhasil diaktifkan sebagai embed. Pesan bot akan selalu muncul di paling bawah.');
        setTimeout(() => confirmation2.delete().catch(() => {}), 5000);
        return;
    }

    if (lower === '?stop') {
        if (!ADMIN_USER_IDS.includes(message.author.id)) {
            return await message.reply('⚠️ Kamu tidak punya izin untuk menjalankan perintah ini.');
        }
        await message.delete().catch(() => {});
        const removed = await removeStickyMessage(message.channel);
        if (!removed) {
            return await message.channel.send('⚠️ Tidak ada sticky message aktif di channel ini.');
        }
        const stopConfirm = await message.channel.send('🛑 Sticky message dihentikan.');
        setTimeout(() => stopConfirm.delete().catch(() => {}), 5000);
        return;
    }

    if (activeSticky && message.id !== activeSticky.messageId) {
        await setStickyMessage(message.channel, activeSticky.content).catch(() => {});
    }

    const hasImageAttachment = [...message.attachments.values()].some(att => att.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.name || ''));
    if (message.attachments.size > 0 && hasImageAttachment && pendingPayments.has(channelId)) {
        pendingPayments.delete(channelId);
        await message.channel.send({
            content: '<a:Verify:1470136337632985199> Transaksi berhasil. Ini File Club Kit RBXM Nya~',
            files: [PAYMENT_RBXM_FILE]
        }).catch(error => console.error('Error sending RBXM file:', error));
        return;
    }

    if (message.content.toLowerCase() === '.vouch') {
        if (!ADMIN_USER_IDS.includes(message.author.id)) return;
        if (!message.channel.name.startsWith('ticket-')) return;

        await message.delete();
        await message.channel.send({
            content: `${message.author}, Silakan isi data`,
            components: [StaffInputTrigger.create()]
        });
    }

    if (message.content.startsWith('?verify-panel')) {
        if (!ADMIN_USER_IDS.includes(message.author.id)) {
            await message.reply('⚠️ Kamu tidak punya izin untuk menggunakan perintah ini.');
            return;
        }

        await message.delete();

        const embed = new EmbedBuilder()
            .setTitle('<a:Bot:1288897921328218124> **ZaneXyuu Studio - VERIFICATION**')
            .setDescription('**Silakan Verifikasi Terlebih Dahulu**\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬')
            .setColor(0x27D3F5)
            .addFields(
                { name: '<a:Done:1504531338340995173> **Cara Verifikasi:**', value: 'Klik tombol **Verification Here** di bawah ini', inline: false },
                { name: '<a:Warning:1470135725499613256> **Catatan:**', value: 'Hubungi admin jika ada masalah.', inline: false },
                { name: 'Terima kasih dan selamat bergabung! <a:Anime:1504546302652977283>', value: '\u200b', inline: false }
            )
            .setThumbnail('https://cdn.discordapp.com/attachments/1374335784613843000/1504514958950666381/pp.png?ex=6a07443e&is=6a05f2be&hm=697c8482c8b2f6181a1670f503d24c8f1eb34c4fb020ddf16136281604f20689')
            .setImage('https://cdn.discordapp.com/attachments/1374335784613843000/1504513784473980975/verify.png?ex=6a074326&is=6a05f1a6&hm=5cb4b19834c0a378d72e6a2ad322e8ea7a3fdbb1ec3d69b41371cc3c0b683d23')
            .setFooter({ text: 'Made by ZaneXyuu Studio', iconURL: 'https://cdn.discordapp.com/emojis/1273384825801412638.gif?size=512' })

        await message.channel.send({ embeds: [embed], components: [VerifyPanelButton.create()] });
    } else if (message.content.startsWith('?zanexyuu')) {
        if (!ADMIN_USER_IDS.includes(message.author.id)) {
            await message.reply('⚠️ Kamu tidak punya izin untuk menjalankan perintah ini.');
            return;
        }

        await message.delete();

        const embed = new EmbedBuilder()
            .setTitle('ZaneXyuu Studio - Services <a:Verify:1470136337632985199>')
            .setDescription('────────────────────────────\n')
            .setColor(0xffffff)
            .setThumbnail('https://cdn.discordapp.com/attachments/1374335784613843000/1504522284789010524/pp.png?ex=6a074b11&is=6a05f991&hm=2e73ce5c0ce99d9fcb7dd03a915bb81880063f3f8f9cd79ae998ad3127acb52c')
            .setImage('https://cdn.discordapp.com/attachments/1374335784613843000/1504394244838920263/zx.gif?ex=6a06d3d2&is=6a058252&hm=69ccab26c9d79a32156cff02366460eeceefbef524cd7d30366f8e663e0fd8cd')
            .setFooter({ iconURL: 'https://cdn.discordapp.com/emojis/1276232127817584670.gif?size=512', text: 'Made by ZaneXyuu Studio' })
            .addFields(
                { name: '<a:RS:1504384160821674005> Order Club Kit', value: 'Pesan Club Kit dengan layanan terbaik dan cepat.', inline: false },
                { name: '<a:Thunder:1277088364570607616> Jasa Service', value: 'Layanan service roblox studio', inline: false },
                { name: '<a:Discord:1504387168179720242> Jasa Setup DC', value: 'Jasa setup Discord server dan konfigurasi bot.', inline: false },
                { name: '<a:Bot:1288897921328218124> Jasa Custom Bot', value: 'Jasa pembuatan custom bot sesuai kebutuhanmu.', inline: false }
            );

        await message.channel.send({ embeds: [embed], components: [TicketView.create()] });
    } else if (message.content.startsWith('?pay')) {
        if (!ADMIN_USER_IDS.includes(message.author.id)) {
            await message.reply('⚠️ Kamu tidak punya izin untuk menggunakan command ini.');
            return;
        }

        await message.delete().catch(() => {});
        pendingPayments.set(channelId, { adminId: message.author.id, timestamp: Date.now() });

        const embed = new EmbedBuilder()
                .setTitle('💳 ZaneXyuu Studio - PAYMENT')
                .setDescription(
                    '<:Dana:1276235987298681003> DANA : 082134394025\n' +
                    '<:Member:1505117845313421373> A/N : Asih Mujianti\n\n' +
                    '<a:Warning:1470135725499613256> **Silakan kirim screenshot bukti transaksi di sini.**'
                )
                .setColor(0x00ffcc)
                .setThumbnail('https://cdn.discordapp.com/attachments/1374335784613843000/1504522284789010524/pp.png?ex=6a074b11&is=6a05f991&hm=2e73ce5c0ce99d9fcb7dd03a915bb81880063f3f8f9cd79ae998ad3127acb52c')
                .setFooter({ text: 'ZaneXyuu Studio • Payment Information' });
        await message.channel.send({ embeds: [embed] });
    }
});

client.on('guildMemberAdd', async member => {
    try {
        const welcomeChannelId = WELCOME_CHANNEL_ID[0];
        if (!welcomeChannelId) return;
        
        const channel = member.guild.channels.cache.get(welcomeChannelId);
        if (!channel || !channel.isTextBased()) return;

        const embed = new EmbedBuilder()
            .setTitle('<a:Star:1504544377501122702> Welcome to ZaneXyuu Studio')
            .setDescription(
                `**Halo ${member.toString()} selamat datang!**\n` +
                '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬\n' +
                '**Silahkan Verifikasi Disini https://discordapp.com/channels/1275131880781647932/1504536044886950029** <a:Cat:1504530621446361218>\n' +
                '▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬'
            )
            .setColor(0xFFFFFF)
            .setThumbnail(member.displayAvatarURL({ dynamic: true, size: 512 }))
            .setImage('https://cdn.discordapp.com/attachments/1374335784613843000/1504523490886156343/banner.png?ex=6a074c30&is=6a05fab0&hm=face41adbf77fb71bb666e3e46f8bf9a31f35adcab664d8649f4ade797c0618c')
            .setFooter({ 
                text: `Member ke-${member.guild.memberCount}`, 
                iconURL: member.guild.iconURL() || undefined 
            })
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('Error sending welcome message:', error);
    }
});

async function registerSlashCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('transaksi')
            .setDescription('Tambahkan transaksi ke pengguna')
            .addUserOption(option => option.setName('member').setDescription('Member yang melakukan transaksi').setRequired(true))
            .addStringOption(option => option.setName('jumlah').setDescription('Jumlah transaksi (misalnya: 100.000)').setRequired(true)),
        new SlashCommandBuilder()
            .setName('total_transaksi')
            .setDescription('Lihat total transaksi kamu'),
        new SlashCommandBuilder()
            .setName('add_user')
            .setDescription('Tambahkan user ke ticket ini')
            .addUserOption(option => option.setName('member').setDescription('User yang ingin ditambahkan ke ticket').setRequired(true)),
        new SlashCommandBuilder()
            .setName('add_spend')
            .setDescription('Tambah nominal Top Spender (Admin Only)')
            .addUserOption(option => option.setName('user').setDescription('Pilih User yang ingin ditambahkan').setRequired(true))
            .addStringOption(option => option.setName('nominal').setDescription('Nominal yang dihabiskan (misal: 125K atau 125.000)').setRequired(true)),
        new SlashCommandBuilder()
            .setName('remove_spend')
            .setDescription('Kurangi nominal Top Spender (Admin Only)')
            .addUserOption(option => option.setName('user').setDescription('Pilih User yang ingin dikurangi').setRequired(true))
            .addStringOption(option => option.setName('nominal').setDescription('Nominal yang dikurangkan (misal: 125K atau 125.000)').setRequired(true)),
        new SlashCommandBuilder()
            .setName('leaderboard')
            .setDescription('Lihat daftar Top Spender'),
        new SlashCommandBuilder()
            .setName('generate')
            .setDescription('Generate Private Server Roblox')
            .addStringOption(option => option.setName('id').setDescription('Roblox game ID').setRequired(true))
        ,
        new SlashCommandBuilder()
            .setName('announce')
            .setDescription('Buat announcement embed')
            .addChannelOption(option => option.setName('channel').setDescription('Pilih channel tujuan').setRequired(true))
            .addStringOption(option => option.setName('mention').setDescription('Mention type').addChoices(
                { name: 'Everyone', value: 'everyone' },
                { name: 'Here', value: 'here' },
                { name: 'None', value: 'none' }
            ).setRequired(false))
            .addIntegerOption(option => option.setName('delay').setDescription('Delay sebelum dikirim (detik)').setRequired(false)),
        new SlashCommandBuilder()
            .setName('edit_announcement')
            .setDescription('Edit announcement terakhir')
            .addStringOption(option => option.setName('new_text').setDescription('Teks baru untuk announcement').setRequired(true))
    ];

    const guildIds = Array.isArray(GUILD_ID) ? GUILD_ID : [GUILD_ID];
    await client.application.commands.set([]);
    for (const guildId of guildIds) {
        await client.application.commands.set([], guildId);
        await client.application.commands.set(commands, guildId);
    }
}
const token = process.env.DISCORD_TOKEN;
if (!token) {
    console.error('DISCORD_TOKEN belum dimasukan');
    process.exit(1);
}
loginBot(token);
