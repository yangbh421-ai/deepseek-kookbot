require('dotenv').config();
const { Client, Intents, Card, CardMessage, Element, Types } = require('khl.js');

// 读取环境变量
const token = process.env.KOOK_TOKEN;
const guildId = process.env.GUILD_ID;
const pcRoleId = process.env.PC_ROLE_ID;
const consoleRoleId = process.env.CONSOLE_ROLE_ID;
const announceChannelId = process.env.ANNOUNCE_CHANNEL_ID;
const adminRoleId = process.env.ADMIN_ROLE_ID; // 可选

// 检查必填项
if (!token || !guildId || !pcRoleId || !consoleRoleId || !announceChannelId) {
    console.error('缺少必要的环境变量：KOOK_TOKEN, GUILD_ID, PC_ROLE_ID, CONSOLE_ROLE_ID, ANNOUNCE_CHANNEL_ID');
    process.exit(1);
}

// 表情与角色映射
const emojiRoleMap = {
    '🖱️': pcRoleId,
    '🎮': consoleRoleId
};

// 卡片消息的唯一标识文本（用于查找已发送的卡片消息）
const CARD_MARKER = '【角色自助分配卡片】请点击下方表情获取对应角色：';

// 全局变量存储当前卡片消息的ID
let cardMessageId = null;

// 初始化客户端
const client = new Client({
    token: token,
    intents: [Intents.GUILDS, Intents.GUILD_MESSAGE_REACTIONS, Intents.GUILD_MESSAGES]
});

// ---------- 辅助函数 ----------

/**
 * 查找频道中机器人发送的卡片消息
 * @returns {Promise<Object|null>} 消息对象或null
 */
async function findCardMessage() {
    try {
        // 获取频道中最近 100 条消息
        const messages = await client.api.message.list(announceChannelId, { page_size: 100 });
        // 倒序查找，最新的在前
        for (const msg of messages) {
            if (msg.author_id === client.user.id && msg.content.includes(CARD_MARKER)) {
                return msg;
            }
        }
    } catch (err) {
        console.error('查找卡片消息失败:', err.message);
    }
    return null;
}

/**
 * 发送新的卡片消息
 * @returns {Promise<Object>} 消息对象
 */
async function sendRoleCard() {
    // 构建卡片消息
    const card = new Card()
        .addModule(new Element.Text(CARD_MARKER + '\n🖱️ PC平台\n🎮 主机平台', Types.Text.KMD))
        .addModule(new Element.Divider());
    const cardMsg = new CardMessage(card);

    try {
        const msg = await client.api.message.create(announceChannelId, cardMsg, { type: 10 });
        console.log(`卡片消息已发送，ID: ${msg.msg_id}`);
        return msg;
    } catch (err) {
        console.error('发送卡片消息失败:', err.message);
        throw err;
    }
}

/**
 * 检查用户是否有权限执行指令
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isAdmin(userId) {
    try {
        // 如果指定了管理员角色ID，则检查用户是否拥有该角色
        if (adminRoleId) {
            const user = await client.api.guild.userView(guildId, userId);
            return user.roles.includes(adminRoleId);
        }
        // 否则检查用户是否为服务器管理员
        const user = await client.api.guild.userView(guildId, userId);
        return user.is_admin === true;
    } catch (err) {
        console.error('检查管理员权限失败:', err.message);
        return false;
    }
}

/**
 * 给用户添加角色
 * @param {string} userId
 * @param {string} roleId
 */
async function addRole(userId, roleId) {
    try {
        await client.api.guild.grantUserRole(guildId, userId, roleId);
        console.log(`已为用户 ${userId} 添加角色 ${roleId}`);
    } catch (err) {
        console.error(`添加角色失败 (用户: ${userId}, 角色: ${roleId}):`, err.message);
    }
}

/**
 * 移除用户的角色
 * @param {string} userId
 * @param {string} roleId
 */
async function removeRole(userId, roleId) {
    try {
        await client.api.guild.revokeUserRole(guildId, userId, roleId);
        console.log(`已为用户 ${userId} 移除角色 ${roleId}`);
    } catch (err) {
        console.error(`移除角色失败 (用户: ${userId}, 角色: ${roleId}):`, err.message);
    }
}

/**
 * 同步角色：确保卡片消息上的反应与用户角色完全一致
 * 1. 遍历卡片上的每个反应，为对应的用户添加角色（如果缺失）
 * 2. 获取服务器中拥有这两个角色的所有用户，移除那些没有对应反应的用户角色
 */
async function syncRolesForCard() {
    if (!cardMessageId) {
        console.log('未找到卡片消息，跳过同步');
        return;
    }

    console.log('开始同步角色...');

    // 获取卡片消息的详细信息（包括 reactions）
    let msg;
    try {
        msg = await client.api.message.view(cardMessageId);
        if (!msg) {
            console.log('卡片消息不存在，跳过同步');
            return;
        }
    } catch (err) {
        console.error('获取卡片消息失败:', err.message);
        return;
    }

    // 收集卡片消息上的反应用户
    const reactionUsersMap = {}; // { roleId: Set(userId) }
    for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
        const reaction = msg.reactions?.find(r => r.emoji.name === emoji);
        if (reaction && reaction.users) {
            reactionUsersMap[roleId] = new Set(reaction.users.map(u => u.id));
        } else {
            reactionUsersMap[roleId] = new Set();
        }
    }

    // 第一步：为有反应的用户添加角色（如果缺失）
    for (const [roleId, users] of Object.entries(reactionUsersMap)) {
        for (const userId of users) {
            // 检查用户是否已有该角色（可以不加检查直接添加，API会返回错误，但会增加调用）
            // 为了减少无效调用，可先获取用户信息检查，但会增加请求。这里选择直接添加，捕获错误即可。
            await addRole(userId, roleId);
        }
    }

    // 第二步：获取服务器中拥有这两个角色的所有用户，移除那些没有对应反应的用户
    // 注意：KOOK API 获取所有成员需要分页，这里简单起见，只获取前 1000 个，如果服务器人数多可能不全
    // 更严谨的做法是循环分页，但为了简化，假设服务器人数不超过 1000
    let allMembers = [];
    let page = 1;
    while (true) {
        const members = await client.api.guild.userList(guildId, { page, page_size: 200 });
        if (!members || members.length === 0) break;
        allMembers.push(...members);
        if (members.length < 200) break;
        page++;
    }

    // 筛选出拥有这两个角色的用户
    for (const member of allMembers) {
        const userId = member.id;
        for (const [emoji, roleId] of Object.entries(emojiRoleMap)) {
            if (member.roles.includes(roleId)) {
                // 用户拥有此角色，检查是否有对应反应
                if (!reactionUsersMap[roleId]?.has(userId)) {
                    await removeRole(userId, roleId);
                }
            }
        }
    }

    console.log('同步完成');
}

/**
 * 处理反应添加
 * @param {string} userId
 * @param {string} emoji
 */
async function handleReactionAdd(userId, emoji) {
    const roleId = emojiRoleMap[emoji];
    if (!roleId) return;
    await addRole(userId, roleId);
}

/**
 * 处理反应移除
 * @param {string} userId
 * @param {string} emoji
 */
async function handleReactionRemove(userId, emoji) {
    const roleId = emojiRoleMap[emoji];
    if (!roleId) return;
    await removeRole(userId, roleId);
}

// ---------- 事件监听 ----------

// 消息创建事件：处理指令
client.on('message', async (msg) => {
    // 只处理普通文本消息
    if (msg.type !== 1) return;

    const content = msg.content;
    // 指令：!sendcard
    if (content === '!sendcard') {
        // 权限检查
        const isAuthorized = await isAdmin(msg.author_id);
        if (!isAuthorized) {
            // 回复提示（可选，不回复也无伤大雅）
            try {
                await client.api.message.create(msg.channel_id, '你没有权限执行此指令。');
            } catch (err) {
                console.error('回复权限提示失败:', err.message);
            }
            return;
        }

        // 发送卡片消息
        try {
            const newMsg = await sendRoleCard();
            cardMessageId = newMsg.msg_id;
            // 发送后立即同步一次，确保初始状态正确（卡片刚发，无反应，因此角色应该为空）
            await syncRolesForCard();
            // 回复确认
            await client.api.message.create(msg.channel_id, '卡片已发送，并已同步角色状态。');
        } catch (err) {
            console.error('发送卡片失败:', err);
            await client.api.message.create(msg.channel_id, '发送卡片失败，请检查日志。');
        }
    }
});

// 反应添加事件
client.on('message_reaction_added', async (event) => {
    const { emoji, user_id, guild_id, msg_id } = event;
    if (guild_id !== guildId) return;
    if (msg_id !== cardMessageId) return;
    // 忽略机器人自己的反应
    if (user_id === client.user.id) return;

    const emojiName = emoji.name;
    await handleReactionAdd(user_id, emojiName);
});

// 反应移除事件
client.on('message_reaction_removed', async (event) => {
    const { emoji, user_id, guild_id, msg_id } = event;
    if (guild_id !== guildId) return;
    if (msg_id !== cardMessageId) return;
    if (user_id === client.user.id) return;

    const emojiName = emoji.name;
    await handleReactionRemove(user_id, emojiName);
});

// 机器人就绪
client.on('ready', async () => {
    console.log(`机器人已登录: ${client.user.username}`);

    // 尝试查找已有的卡片消息
    const existingCard = await findCardMessage();
    if (existingCard) {
        cardMessageId = existingCard.msg_id;
        console.log(`找到已有卡片消息，ID: ${cardMessageId}`);
        // 立即同步一次
        await syncRolesForCard();
    } else {
        console.log('未找到已有卡片消息，请使用 !sendcard 指令发送。');
    }

    // 设置定时任务：每24小时同步一次
    setInterval(async () => {
        console.log('执行定时同步...');
        await syncRolesForCard();
    }, 24 * 60 * 60 * 1000);
});

// 启动机器人
client.connect();