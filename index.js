require('dotenv').config();
const axios = require('axios');

const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;
const adminRoleId = process.env.ADMIN_ROLE_ID;

if (!token || !guildId || !pcRoleId || !consoleRoleId || !announceChannelId) {
    console.error('缺少必要的环境变量');
    process.exit(1);
}

const BASE_URL = 'https://www.kookapp.cn/api/v3';
const client = axios.create({
    baseURL: BASE_URL,
    headers: { 'Authorization': `Bot ${token}` }
});

const emojiRoleMap = {
    '🖱️': pcRoleId,
    '🎮': consoleRoleId
};

const CARD_MARKER = '【角色自助分配卡片】请点击下方表情获取对应角色：';
let cardMessageId = null;

// WebSocket 相关
let ws = null;
let wsUrl = null;
let heartbeatInterval = null;

async function getGateway() {
    try {
        const res = await client.get('/gateway/index');
        return res.data.data.url;
    } catch (err) {
        console.error('获取 Gateway 失败:', err.message);
        return null;
    }
}

function sendWsHeartbeat() {
    if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ s: 2 }));
    }
}

function connectWebSocket() {
    getGateway().then(url => {
        if (!url) return setTimeout(connectWebSocket, 5000);
        ws = new WebSocket(url);
        ws.onopen = () => {
            console.log('WebSocket 已连接');
            heartbeatInterval = setInterval(sendWsHeartbeat, 30000);
        };
        ws.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            if (data.s === 0) return; // 心跳响应
            const { d, t } = data;
            if (t === 'MESSAGE_REACTION_ADDED') {
                await handleReaction(d, true);
            } else if (t === 'MESSAGE_REACTION_REMOVED') {
                await handleReaction(d, false);
            } else if (t === 'MESSAGE_CREATE') {
                await handleMessage(d);
            } else if (t === 'READY') {
                console.log('WS Ready, session:', d.session_id);
                // 启动后查找已有卡片
                findCardMessage();
                // 启动同步定时器
                setInterval(syncRoles, 24 * 60 * 60 * 1000);
                syncRoles(); // 立即同步一次
            }
        };
        ws.onerror = (err) => {
            console.error('WebSocket 错误:', err);
        };
        ws.onclose = () => {
            console.log('WebSocket 断开，5秒后重连');
            clearInterval(heartbeatInterval);
            setTimeout(connectWebSocket, 5000);
        };
    });
}

async function handleReaction(d, isAdd) {
    const { emoji, user_id, guild_id, msg_id } = d;
    if (guild_id !== guildId) return;
    if (msg_id !== cardMessageId) return;
    const roleId = emojiRoleMap[emoji.name];
    if (!roleId) return;
    try {
        if (isAdd) {
            await client.post(`/guild-role/grant`, {
                guild_id: guildId,
                user_id: user_id,
                role_id: roleId
            });
            console.log(`添加角色 ${roleId} 给用户 ${user_id}`);
        } else {
            await client.post(`/guild-role/revoke`, {
                guild_id: guildId,
                user_id: user_id,
                role_id: roleId
            });
            console.log(`移除角色 ${roleId} 给用户 ${user_id}`);
        }
    } catch (err) {
        console.error(`操作角色失败:`, err.response?.data || err.message);
    }
}

async function handleMessage(d) {
    const { author, content, channel_id, msg_id } = d;
    if (content !== '!sendcard') return;
    // 权限检查
    let isAdmin = false;
    try {
        const res = await client.get(`/guild/view`, { params: { guild_id: guildId } });
        const guild = res.data.data;
        if (adminRoleId) {
            const userRes = await client.get(`/guild/user-view`, {
                params: { guild_id: guildId, user_id: author.id }
            });
            isAdmin = userRes.data.data.roles.includes(adminRoleId);
        } else {
            isAdmin = author.is_admin === true;
        }
    } catch (err) {
        console.error('权限检查失败:', err.message);
    }
    if (!isAdmin) {
        await client.post(`/message/create`, {
            target_id: channel_id,
            content: '你没有权限执行此指令。',
            type: 1
        });
        return;
    }
    // 发送卡片
    const cardJson = {
        type: "card",
        theme: "info",
        modules: [
            {
                type: "section",
                text: {
                    type: "kmarkdown",
                    content: CARD_MARKER + '\n🖱️ PC平台\n🎮 主机平台'
                }
            },
            { type: "divider" }
        ]
    };
    try {
        const res = await client.post(`/message/create`, {
            target_id: announceChannelId,
            content: JSON.stringify(cardJson),
            type: 10
        });
        cardMessageId = res.data.data.msg_id;
        console.log(`卡片已发送: ${cardMessageId}`);
        await client.post(`/message/create`, {
            target_id: channel_id,
            content: '卡片已发送，并已同步角色状态。',
            type: 1
        });
    } catch (err) {
        console.error('发送卡片失败:', err.response?.data || err.message);
        await client.post(`/message/create`, {
            target_id: channel_id,
            content: '发送卡片失败，请检查日志。',
            type: 1
        });
    }
}

async function findCardMessage() {
    try {
        const res = await client.get(`/message/list`, {
            params: { target_id: announceChannelId, page_size: 100 }
        });
        const messages = res.data.data;
        for (const msg of messages) {
            if (msg.author.id === 'bot' && msg.content.includes(CARD_MARKER)) {
                cardMessageId = msg.id;
                console.log(`找到已有卡片消息: ${cardMessageId}`);
                break;
            }
        }
    } catch (err) {
        console.error('查找卡片失败:', err.message);
    }
}

async function syncRoles() {
    if (!cardMessageId) {
        console.log('未找到卡片消息，跳过同步');
        return;
    }
    console.log('开始同步角色...');
    try {
        // 获取卡片消息详情
        const msgRes = await client.get(`/message/view`, { params: { msg_id: cardMessageId } });
        const msg = msgRes.data.data;
        const reactions = msg.reactions || [];

        // 收集每个角色的反应用户
        const reactionUsers = {};
        for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
            const react = reactions.find(r => r.emoji.name === emoji);
            if (react && react.users) {
                reactionUsers[roleId] = new Set(react.users.map(u => u.id));
            } else {
                reactionUsers[roleId] = new Set();
            }
        }

        // 为有反应的用户添加角色
        for (const [roleId, users] of Object.entries(reactionUsers)) {
            for (const userId of users) {
                try {
                    await client.post(`/guild-role/grant`, {
                        guild_id: guildId,
                        user_id: userId,
                        role_id: roleId
                    });
                    console.log(`同步添加: 用户 ${userId} 角色 ${roleId}`);
                } catch (err) {
                    // 可能已拥有，忽略错误
                }
            }
        }

        // 获取服务器成员列表
        let allMembers = [];
        let page = 1;
        while (true) {
            const membersRes = await client.get(`/guild/user-list`, {
                params: { guild_id: guildId, page, page_size: 200 }
            });
            const members = membersRes.data.data;
            if (!members || members.length === 0) break;
            allMembers.push(...members);
            if (members.length < 200) break;
            page++;
        }

        // 移除没有对应反应的角色
        for (const member of allMembers) {
            for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
                if (member.roles && member.roles.includes(roleId)) {
                    if (!reactionUsers[roleId]?.has(member.id)) {
                        try {
                            await client.post(`/guild-role/revoke`, {
                                guild_id: guildId,
                                user_id: member.id,
                                role_id: roleId
                            });
                            console.log(`同步移除: 用户 ${member.id} 角色 ${roleId}`);
                        } catch (err) {
                            // 忽略
                        }
                    }
                }
            }
        }
        console.log('同步完成');
    } catch (err) {
        console.error('同步失败:', err.message);
    }
}

// 启动
connectWebSocket();
