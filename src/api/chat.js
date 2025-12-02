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
import { createSession, getSession, updateSession, updateIntent, transitionPhase, setPendingRunState, clearPendingRunState } from '../conversation/state.js';
import { createRoamingAgent } from '../agent/config.js';
import { run, withTrace, RunState } from '@openai/agents';
import { runWithContext } from '../agent/context-store.js';

// 載入環境變數
dotenv.config();

const router = express.Router();

// 建立 Agent 實例（單例模式）
let agentInstance = null;

async function getAgent() {
  if (!agentInstance) {
    agentInstance = await createRoamingAgent();
    console.log('[Agent] 已建立 Roaming Agent 實例');
  }
  return agentInstance;
}

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
    // 在 context store 中執行，使 userId 可被所有 agent 訪問
    await runWithContext({ userId: req.body.userId }, async () => {
      await withTrace('001-roaming-assistant', async () => {

        const { userId, sessionId, message } = req.body;
      console.log(`[API] POST /chat - userId: ${userId}, sessionId: ${sessionId}, message: "${message?.substring(0, 50)}${message?.length > 50 ? '...' : ''}"`);
      
      // 驗證必填欄位
      if (!userId || typeof userId !== 'string') {
        return res.status(400).json({
          error: '缺少必填欄位：userId'
        });
      }
      
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).json({
          error: '缺少必填欄位：message'
        });
      }
      
      // 取得或建立會話
      let session;
      
      if (sessionId) {
        // 嘗試取得現有會話
        session = getSession(sessionId);
        
        if (!session) {
          return res.status(404).json({
            error: '會話不存在或已過期',
            sessionId
          });
        }
        
        // 驗證使用者身份
        if (session.userId !== userId) {
          return res.status(403).json({
            error: '會話不屬於此使用者'
          });
        }
      } else {
        // 建立新會話
        const newSessionId = await createSession(userId);
        session = getSession(newSessionId);
      }
      
      // 記錄使用者訊息（僅供 UI 顯示）
      const userMessage = {
        role: 'user',
        content: message,
        timestamp: new Date()
      };
      
      session.messages.push(userMessage);
      
      console.log("[Agent] Using OpenAIConversationsSession for conversation history");

      // 使用 Agents API 執行對話 + Human-in-the-loop
      const agent = await getAgent();
      let assistantResponse = '抱歉，我遇到了一些問題。請稍後再試。';
      try {
        // 當前使用者訊息是否為批准/確認關鍵字
        const approvalKeywords = ['是','對','好','ok','OK','可以','請','繼續','要','需要','批准','同意','沒錯'];
        const isApprovalMessage = approvalKeywords.some(k => message.includes(k));

        // 若已有 pendingRunState，處理恢復或提示
        if (session.pendingRunState) {
          if (isApprovalMessage) {
            console.log('[HITL] 使用者批准，恢復中斷執行');
            const restored = await RunState.fromString(agent, session.pendingRunState);
            for (const interruption of session.pendingInterruptions) {
              if (interruption.original) restored.approve(interruption.original);
            }
            clearPendingRunState(session.sessionId);
            const resumed = await run(agent, restored, { session: session.conversationsSession });
            assistantResponse = resumed.finalOutput || assistantResponse;
            for (const item of resumed.newItems) {
              if (item.type === 'function_call_output' || item.type === 'function_output') {
                console.log('[Agent] 工具呼叫結果:', item);
              }
            }
          } else {
            assistantResponse = '目前有等待您確認的操作：是否允許查詢漫遊方案或產生推薦？請回覆「好」或「可以」來批准。';
          }
        } else {
          // 正常執行一次 - 使用 OpenAIConversationsSession 自動管理歷史
          let firstResult = await run(agent, message, { session: session.conversationsSession });

          // 如果剛好在此輪出現中斷且使用者訊息本身就是批准 → 立即自動批准並再執行
            if (firstResult.interruptions?.length) {
              console.log(`[HITL] 擷取到 ${firstResult.interruptions.length} 個需要批准的工具呼叫`);
              if (isApprovalMessage) {
                console.log('[HITL] 使用者訊息即為批准，立即執行中斷工具');
                let currentResult = firstResult;
                
                // 循環處理所有中斷，直到沒有更多中斷為止
                while (currentResult.interruptions?.length > 0) {
                  console.log(`[HITL] 處理 ${currentResult.interruptions.length} 個中斷...`);
                  for (const interruption of currentResult.interruptions) {
                    currentResult.state.approve(interruption);
                  }
                  currentResult = await run(agent, currentResult.state, { session: session.conversationsSession });
                  
                  // 記錄工具呼叫結果
                  for (const item of currentResult.newItems) {
                    if (item.type === 'function_call_output' || item.type === 'function_output') {
                      console.log('[Agent] 工具呼叫結果:', item);
                    }
                  }
                }
                
                assistantResponse = currentResult.finalOutput || assistantResponse;
              } else {
                // 暫存等待後續批准
                const simplified = firstResult.interruptions.map(i => ({
                  name: i.name,
                  agentName: i.agent.name,
                  arguments: i.arguments,
                  original: i
                }));
                setPendingRunState(session.sessionId, firstResult.state.toString(), simplified);
                assistantResponse = '需要您的確認才能繼續：是否允許我查詢漫遊方案或產生推薦？請回覆「好」或「可以」來批准。';
              }
            } else {
              assistantResponse = firstResult.finalOutput || assistantResponse;
              for (const item of firstResult.newItems) {
                if (item.type === 'function_call_output' || item.type === 'function_output') {
                  console.log('[Agent] 工具呼叫結果:', item);
                }
              }
            }
        }
        console.log('[Agent] 執行完成');
      } catch (agentError) {
        console.error('[Agent 執行錯誤]', agentError);
        assistantResponse = '抱歉，系統目前無法處理您的請求。請稍後再試。';
      }
      
      // 分析回應內容，更新會話狀態
      const stateUpdates = analyzeAgentResponse(assistantResponse, session, message);
      
      if (stateUpdates.intent) {
        updateIntent(session.sessionId, stateUpdates.intent);
      }
      
      if (stateUpdates.phase) {
        transitionPhase(session.sessionId, stateUpdates.phase);
      }
      
      // 記錄助理回應
      const assistantMessage = {
        role: 'assistant',
        content: assistantResponse,
        timestamp: new Date()
      };
      
      session.messages.push(assistantMessage);
      
      // 更新會話狀態
      const updatedSession = updateSession(session.sessionId, {
        messages: session.messages
      });
      
      // 建構 API 回應
      const response = buildApiResponse(updatedSession, assistantResponse);
      
      console.log(`[API] Response sent - sessionId: ${response.sessionId}, phase: ${response.phase}, hasData: ${!!response.data}`);
      res.json(response);
      });
    });
  } catch (error) {
    console.error('[API 錯誤]', error);
    
    res.status(500).json({
      error: '處理訊息時發生錯誤',
      message: error.message
    });
  }
});

/**
 * 分析 Agent 回應內容，提取狀態更新
 * 
 * @param {string} response - Agent 回應
 * @param {object} session - 當前會話狀態
 * @param {string} userMessage - 使用者訊息
 * @returns {object} 狀態更新內容
 */
function analyzeAgentResponse(response, session, userMessage) {
  const updates = {
    intent: null,
    phase: null
  };
  
  // 偵測目的地國家
  const countryKeywords = [
    '日本', '韓國', '美國', '英國', '法國', '德國', '義大利',
    '西班牙', '泰國', '新加坡', '馬來西亞', '香港', '澳門',
    '中國', '澳洲', '紐西蘭', '加拿大', '越南', '印尼'
  ];
  
  let detectedCountry = null;
  
  for (const country of countryKeywords) {
    if (userMessage.includes(country) || response.includes(country)) {
      detectedCountry = country;
      break;
    }
  }
  
  // 狀態機邏輯
  if (session.phase === 'intent-detection') {
    // 階段 1: 意圖偵測
    if (detectedCountry && !session.intent.destination) {
      updates.intent = {
        destination: detectedCountry,
        detectedAt: new Date(),
        confirmed: false,
        userApproved: false
      };
      updates.phase = 'confirmation';
    }
  } else if (session.phase === 'confirmation') {
    // 階段 2: 確認意圖（合併批准）
    const confirmationKeywords = ['是', '對', '沒錯', '正確', '好', 'OK', '可以', '請幫我', '麻煩', '繼續', '要', '需要'];
    const hasConfirmation = confirmationKeywords.some(keyword => userMessage.includes(keyword));
    if (hasConfirmation) {
      updates.intent = {
        confirmed: true,
        confirmedAt: new Date(),
        userApproved: true
      };
      updates.phase = 'data-collection';
    }
  }
  
  return updates;
}

/**
 * 建構 API 回應（per contracts/chat-api.md）
 * 
 * @param {object} session - 當前會話狀態
 * @param {string} response - 助理回應文字
 * @returns {object} API 回應物件
 */
function buildApiResponse(session, response) {
  return {
    sessionId: session.sessionId,
    response: response,
    phase: session.phase,
    data: {
      // 僅在資料存在時才包含於回應中
      ...(session.intent.destination && { intent: session.intent }),
      ...(session.usageData && { usage: session.usageData }),
      ...(session.roamingPlans.length > 0 && { plans: session.roamingPlans }),
      ...(session.recommendation && { recommendation: session.recommendation })
    }
  };
}

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
