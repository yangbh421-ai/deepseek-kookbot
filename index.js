require('dotenv').config();
const axios = require('axios');

// ===== 环境变量 =====
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const channelId = process.env.ANNOUNCE_CHANNEL_ID;

if (!token || !guildId || !pcRoleId || !consoleRoleId || !channelId) {
    console.error('❌ 环境变量不完整');
    process.exit(1);
}

const API = 'https://www.kookapp.cn/api/v3';

// ✅ 用来防止重复处理
let handledMsgIds = new Set();
let cardMessageId = null;

// ===== API =====
const api = async (method, url, data = null) => {
    try {
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
    } catch (err) {
        console.error('❌ API错误:', err.response?.data || err.message);
        throw err;
    }
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

// ===== 轮询消息（稳定版）=====
const checkMessages = async () => {
    try {
        const res = await api('get', `/message/list?channel_id=${channelId}&limit=20`);
        const msgs = res.data.items;

        for (const msg of msgs) {

            // ✅ 已处理过直接跳过
            if (handledMsgIds.has(msg.id)) continue;

            handledMsgIds.add(msg.id);

            // ❗ 只处理用户消息（防止机器人自己触发）
            if (msg.author?.bot) continue;

            if (msg.content === '!sendcard') {
                console.log('💬 收到 !sendcard');

                const card = await sendCard();
                cardMessageId = card.msg_id;

                await sendMessage('✅ 卡片已发送（请点击表情获取角色）');
            }
        }

        // ✅ 防止内存无限增长
        if (handledMsgIds.size > 200) {
            handledMsgIds = new Set(Array.from(handledMsgIds).slice(-100));
        }

    } catch (err) {
        console.error('轮询失败:', err.message);
    }
};

// ===== 启动 =====
console.log('🚀 机器人启动（稳定轮询版）');

// 每3秒检查一次
setInterval(checkMessages, 3000);
