/**
 * 聊天 API 路由處理器
 * 
 * 端點：POST /api/chat
 * 功能：處理使用者訊息、管理會話、回傳回應
 * 
 * 使用新的 Agents API (run() 函數) 取代已棄用的 Assistants API
 */

import express from 'express';
import dotenv from 'dotenv';
import { handleChatRequest } from './chat-handler.js';
import { getSession } from '../conversation/state.js';

// 載入環境變數
dotenv.config();

const router = express.Router();

/**
 * POST /api/chat
 * Human-in-the-loop (HITL) 流程說明（新版簡化邏輯）：
 * 1. 使用者首次輸入 → 偵測目的地 → 進入 confirmation 階段並詢問是否需要協助。
 * 2. 使用者回覆確認關鍵字（如「好」/「可以」）→ 直接視為已確認且已批准 (confirmed + userApproved)。
 *    不再進入第二個 "approval" 二次詢問階段，減少一層互動摩擦。
 * 3. 若工具需要批准且使用者訊息本身即為批准關鍵字，立即自動批准並繼續執行中斷的工具呼叫。
 * 4. 若有中斷但尚未取得批准關鍵字，暫存 RunState 並回覆提示等待使用者批准。
 */
router.post('/chat', async (req, res) => {
  try {
    const { userId, sessionId, message } = req.body;
    console.log(`[API] POST /chat - userId: ${userId}, sessionId: ${sessionId}, message: "${message?.substring(0, 50)}${message?.length > 50 ? '...' : ''}"`);
    
    // 呼叫共用的處理函數
    const result = await handleChatRequest({ userId, message, sessionId });
    
    console.log(`[API] Response sent - sessionId: ${result.sessionId}, phase: ${result.phase}, hasData: ${!!result.data}`);
    res.json(result);
  } catch (error) {
    console.error('[API 錯誤]', error);
    
    // 根據錯誤類型返回適當的狀態碼
    if (error.message.includes('缺少必填欄位')) {
      return res.status(400).json({ error: error.message });
    }
    if (error.message.includes('不存在或已過期')) {
      return res.status(404).json({ error: error.message });
    }
    if (error.message.includes('不屬於此使用者')) {
      return res.status(403).json({ error: error.message });
    }
    
    res.status(500).json({
      error: '處理訊息時發生錯誤',
      message: error.message
    });
  }
});

// Debug endpoint（僅開發環境）
if (process.env.NODE_ENV === 'development') {
  router.get('/debug/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        error: '找不到會話或會話已過期',
        sessionId
      });
    }
    
    res.json({
      sessionId: session.sessionId,
      userId: session.userId,
      phase: session.phase,
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.expiresAt,
      intent: session.intent,
      hasUsageData: !!session.usageData,
      roamingPlansCount: session.roamingPlans?.length || 0,
      hasRecommendation: !!session.recommendation,
      messagesCount: session.messages?.length || 0
    });
  });
}

export default router;
