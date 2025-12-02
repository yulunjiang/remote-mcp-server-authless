

import { z } from 'zod';
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { handleChatRequest } from './api/chat-handler.js';
import { initOpenAI } from "./agent/openaiClient.js";

export class MyMCP extends McpAgent{

	server = new McpServer({
		name: "Authless Calculator",
		version: "1.0.0",
	});

  async init() {

	this.server.tool("add", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
		content: [{ type: "text", text: String(a + b) }],
	}));

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
          // 呼叫共用的處理函數
          const result = await handleChatRequest({ userId, message, sessionId });
          
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        } catch (error) {
          console.error('[MCP Chat Tool Error]', error);
          return {
            content: [{ type: 'text', text: this.env.API_HOST }],
            isError: true,
          };
        }
      }
    );

    console.log('[MCP] Chat MCP Server initialized');
  }
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
    initOpenAI(env);   // 每次 request 時注入 env，初始化 openai

		if (url.pathname === "/sse" || url.pathname === "/sse/message") {
			return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
		}

		if (url.pathname === "/mcp") {
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("Not found", { status: 404 });
	},
};

