require('dotenv').config();
const axios = require('axios');

const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const channelId = process.env.ANNOUNCE_CHANNEL_ID;

const API = 'https://www.kookapp.cn/api/v3';

let lastMsgId = null;
let cardMessageId = null;

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
    api('post', '/message/create', { channel_id: channelId, content, type: 1 });

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

// ===== 轮询消息 =====
const checkMessages = async () => {
    try {
        const res = await api('get', `/message/list?channel_id=${channelId}&limit=10`);
        const msgs = res.data.items;

        for (const msg of msgs.reverse()) {

            if (msg.id === lastMsgId) continue;

            lastMsgId = msg.id;

            if (msg.content === '!sendcard') {
                console.log('💬 收到 !sendcard');

                const card = await sendCard();
                cardMessageId = card.msg_id;

                await sendMessage('✅ 卡片已发送');
            }
        }

    } catch (err) {
        console.error('轮询失败:', err.message);
    }
};

// ===== 启动 =====
console.log('🚀 机器人启动（轮询模式）');

// 每3秒检查一次
setInterval(checkMessages, 3000);
