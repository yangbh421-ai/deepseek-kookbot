require('dotenv').config();
const axios = require('axios');

const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const channelId = process.env.ANNOUNCE_CHANNEL_ID;

const API = 'https://www.kookapp.cn/api/v3';

let handledMsgIds = new Set();
let cardMessageId = null;

// ===== API =====
const api = async (method, url, data = null) => {
    const res = await axios({
        method,
        url: API + url,
        headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json'
        },
        data
    });
    return res.data;
};

const sendMessage = (content) =>
    api('post', '/message/create', {
        channel_id: channelId,
        content,
        type: 1
    });

const sendCard = async () => {
    const card = [{
        type: "card",
        theme: "info",
        modules: [{
            type: "section",
            text: {
                type: "kmarkdown",
                content: "【角色自助分配】\n🖱️ PC玩家\n🎮 主机玩家"
            }
        }]
    }];

    const res = await api('post', '/message/create', {
        channel_id: channelId,
        type: 10,
        content: JSON.stringify(card)
    });

    return res.data;
};

const grantRole = (userId, roleId) =>
    api('post', '/guild/grant-role', {
        guild_id: guildId,
        user_id: userId,
        role_id: roleId
    });

// ===== 监听指令 =====
const checkMessages = async () => {
    const res = await api('get', `/message/list?channel_id=${channelId}&limit=20`);
    const msgs = res.data.items;

    for (const msg of msgs) {
        if (handledMsgIds.has(msg.id)) continue;
        handledMsgIds.add(msg.id);

        if (msg.author?.bot) continue;

        if (msg.content === '!sendcard') {
            console.log('💬 收到 !sendcard');

            const card = await sendCard();
            cardMessageId = card.msg_id;

            await sendMessage('✅ 卡片已发送，请点emoji获取角色');
        }
    }
};

// ===== 同步reaction（核心）=====
const syncReactions = async () => {
    if (!cardMessageId) return;

    try {
        const res = await api('get', `/message/view?msg_id=${cardMessageId}`);
        const msg = res.data;

        const reactions = msg.reactions || [];

        for (const r of reactions) {
            const emoji = r.emoji.name;

            let roleId = null;
            if (emoji === '🖱️') roleId = pcRoleId;
            if (emoji === '🎮') roleId = consoleRoleId;

            if (!roleId) continue;

            for (const user of r.users || []) {
                console.log('🎯 给角色:', user.id, emoji);
                await grantRole(user.id, roleId);
            }
        }

    } catch (err) {
        console.error('同步失败:', err.message);
    }
};

// ===== 启动 =====
console.log('🚀 终极稳定版启动');

// 指令监听
setInterval(checkMessages, 3000);

// emoji同步
setInterval(syncReactions, 5000);
