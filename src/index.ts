/**
 * Chat MCP Server
 * 
 * 將聊天 API 功能暴露為 MCP tool，供其他 agent 呼叫
 * 
 * 使用方式：
 * const chatMcpServer = new ChatMcpServer();
 * await chatMcpServer.init();
 * 
 * 然後在其他 Agent 中：
 * mcpServers: [chatMcpServer.server]
 */

import { MCPServerStdio, run, withTrace, RunState } from '@openai/agents';
import { z } from 'zod';
import { createSession, getSession, updateSession, updateIntent, transitionPhase, setPendingRunState, clearPendingRunState } from './conversation/state.js';
import { createRoamingAgent } from './agent/config.js';
import { runWithContext } from './agent/context-store.js';
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export class MyMCP extends McpAgent{
  constructor(env) {
    super();
    this.env = env;
  }

  server = null;
  agentInstance = null;

  async init() {

    server = new McpServer({
      name: "Authless Calculator",
      version: "1.0.0",
    });

    // 註冊 chat tool
    this.server.tool(
      'chat',
      {
        userId: z.string().describe('使用者 ID'),
        message: z.string().describe('使用者訊息'),
        sessionId: z.string().optional().describe('會話 ID (可選，若無則建立新會話)'),
      },
      async ({ userId, message, sessionId }) => {
        try {
          // 在 context store 中執行
          let response = '';
          await runWithContext({ userId }, async () => {
            await withTrace('mcp-chat', async () => {
              // 取得或建立會話
              let session;
              
              if (sessionId) {
                session = getSession(sessionId);
                if (!session || session.userId !== userId) {
                  throw new Error('會話不存在或不屬於此使用者');
                }
              } else {
                const newSessionId = await createSession(userId);
                session = getSession(newSessionId);
              }
              
              // 記錄使用者訊息
              const userMessage = {
                role: 'user',
                content: message,
                timestamp: new Date()
              };
              session.messages.push(userMessage);
              
              // 執行 agent
              const agent = await this.getAgent();
              let assistantResponse = '抱歉，我遇到了一些問題。請稍後再試。';
              
              try {
                const approvalKeywords = ['是','對','好','ok','OK','可以','請','繼續','要','需要','批准','同意','沒錯'];
                const isApprovalMessage = approvalKeywords.some(k => message.includes(k));

                if (session.pendingRunState) {
                  if (isApprovalMessage) {
                    const restored = await RunState.fromString(agent, session.pendingRunState);
                    for (const interruption of session.pendingInterruptions) {
                      if (interruption.original) restored.approve(interruption.original);
                    }
                    clearPendingRunState(session.sessionId);
                    const resumed = await run(agent, restored, { session: session.conversationsSession });
                    assistantResponse = resumed.finalOutput || assistantResponse;
                  } else {
                    assistantResponse = '目前有等待您確認的操作：是否允許查詢漫遊方案或產生推薦？請回覆「好」或「可以」來批准。';
                  }
                } else {
                  let firstResult = await run(agent, message, { session: session.conversationsSession });

                  if (firstResult.interruptions?.length) {
                    if (isApprovalMessage) {
                      let currentResult = firstResult;
                      while (currentResult.interruptions?.length > 0) {
                        for (const interruption of currentResult.interruptions) {
                          currentResult.state.approve(interruption);
                        }
                        currentResult = await run(agent, currentResult.state, { session: session.conversationsSession });
                      }
                      assistantResponse = currentResult.finalOutput || assistantResponse;
                    } else {
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
                  }
                }
              } catch (agentError) {
                console.error('[Agent 執行錯誤]', agentError);
                assistantResponse = '抱歉，系統目前無法處理您的請求。請稍後再試。';
              }
              
              // 記錄助理回應
              const assistantMessage = {
                role: 'assistant',
                content: assistantResponse,
                timestamp: new Date()
              };
              session.messages.push(assistantMessage);
              
              // 更新會話
              updateSession(session.sessionId, {
                messages: session.messages
              });
              
              response = JSON.stringify({
                sessionId: session.sessionId,
                response: assistantResponse,
                phase: session.phase,
                data: {
                  ...(session.intent.destination && { intent: session.intent }),
                  ...(session.usageData && { usage: session.usageData }),
                  ...(session.roamingPlans.length > 0 && { plans: session.roamingPlans }),
                  ...(session.recommendation && { recommendation: session.recommendation })
                }
              });
            });
          });

          return {
            content: [{ type: 'text', text: response }],
          };
        } catch (error) {
          console.error('[MCP Chat Tool Error]', error);
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
            isError: true,
          };
        }
      }
    );

    console.log('[MCP] Chat MCP Server initialized');
  }

  async getAgent() {
    if (!this.agentInstance) {
      this.agentInstance = await createRoamingAgent({
      apiKey: this.env.OPENAI_API_KEY,
    });
    }
    return this.agentInstance;
  }
}

export default {
	fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse", { env }).fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp", { env }).fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};