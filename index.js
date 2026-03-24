require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');

const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const channelId = process.env.ANNOUNCE_CHANNEL_ID;

const API = 'https://www.kookapp.cn/api/v3';

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

const sendCard = async () => {
    const card = [{
        type: "card",
        theme: "info",
        modules: [
            {
                type: "section",
                text: {
                    type: "kmarkdown",
                    content: "【角色自助分配】\n请选择你的平台"
                }
            },
            {
                type: "action-group",
                elements: [
                    {
                        type: "button",
                        text: { type: "plain-text", content: "🖱️ PC玩家" },
                        value: "pc",
                        click: "return-val"
                    },
                    {
                        type: "button",
                        text: { type: "plain-text", content: "🎮 主机玩家" },
                        value: "console",
                        click: "return-val"
                    }
                ]
            }
        ]
    }];

    await api('post', '/message/create', {
        channel_id: channelId,
        type: 10,
        content: JSON.stringify(card)
    });
};

const grantRole = (userId, roleId) =>
    api('post', '/guild/grant-role', {
        guild_id: guildId,
        user_id: userId,
        role_id: roleId
    });

// ===== WS监听按钮点击 =====
const connectWS = async () => {
    const res = await api('get', '/gateway/index');
    const ws = new WebSocket(res.data.url);

    ws.on('open', () => {
        console.log('✅ WS连接');

        ws.send(JSON.stringify({
            type: 'IDENTIFY',
            token: token,
            intents: 0
        }));
    });

    ws.on('message', (msg) => {
        let data;
        try {
            data = JSON.parse(msg.toString());
        } catch {
            return;
        }

        if (!data.d) return;

        // 👉 按钮点击事件
        if (data.d.type === 'message_btn_click') {
            const userId = data.d.user_id;
            const val = data.d.value;

            console.log('按钮点击:', userId, val);

            if (val === 'pc') {
                grantRole(userId, pcRoleId);
            }

            if (val === 'console') {
                grantRole(userId, consoleRoleId);
            }
        }
    });
};

// ===== 启动 =====
console.log('🚀 按钮版启动');

sendCard();
connectWS();
