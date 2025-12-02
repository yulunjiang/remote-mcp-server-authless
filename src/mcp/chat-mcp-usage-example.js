/**
 * Chat MCP Server 使用範例
 * 
 * 示範如何在其他 Agent 中使用 Chat MCP Server
 * 
 * 執行方式：
 * node src/mcp/chat-mcp-usage-example.js
 */

import { Agent, run, withTrace } from '@openai/agents';
import { ChatMcpServer } from './chat-mcp-server.js';
import { openai } from "../agent/openaiClient.js";

async function main() {
  // 1. 初始化 Chat MCP Server
  const chatMcpServer = new ChatMcpServer();
  await chatMcpServer.init();

  // 2. 建立一個使用 chat tool 的 Agent
  const coordinatorAgent = new Agent({
    name: 'Coordinator Agent',
    openai,
    instructions: 
      '你是一個協調者，可以使用 chat tool 與漫遊助理進行對話。' +
      '當使用者提出漫遊相關問題時，使用 chat tool 來處理。',
    mcpServers: [chatMcpServer.server],
  });

  // 3. 執行對話
  await withTrace('chat-mcp-example', async () => {
    console.log('\n=== 範例 1: 建立新會話 ===');
    const result1 = await run(
      coordinatorAgent, 
      '請幫我查詢日本漫遊方案 (userId: demo-user-001)'
    );
    console.log('回應:', result1.finalOutput);

    console.log('\n=== 範例 2: 繼續會話 ===');
    // 假設從第一次回應中取得 sessionId
    const result2 = await run(
      coordinatorAgent,
      '好的，請繼續 (userId: demo-user-001, sessionId: 從上次回應取得)'
    );
    console.log('回應:', result2.finalOutput);
  });

  console.log('\n✅ 範例執行完成');
}

main().catch(console.error);
