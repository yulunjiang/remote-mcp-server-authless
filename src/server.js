/**
 * Express 伺服器進入點
 * 
 * 功能：
 * - 啟動 Express 伺服器於 PORT 8000
 * - 設定 CORS 允許前端存取
 * - 掛載 API 路由
 * - 定期清理過期會話
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import chatRouter from './api/chat.js';
import { cleanupExpiredSessions, getActiveSessionCount } from './conversation/state.js';

// Rate limiting 儲存（sessionId -> {count, resetAt}）
const rateLimitStore = new Map();
const RATE_LIMIT_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 分鐘

// 載入環境變數
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// 允許的來源（前端位址）
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'http://localhost:3001'];

// CORS 設定
app.use(cors({
  origin: (origin, callback) => {
    // 允許無 origin 的請求（例如 curl、Postman）
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('不允許的來源'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 86400 // 24 hours
}));

// JSON 解析中介層
app.use(express.json());

// 請求日誌中介層
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Rate limiting middleware（僅針對 /api/chat）
app.use('/api/chat', (req, res, next) => {
  const sessionId = req.body?.sessionId || req.ip;
  const now = Date.now();
  
  // 取得或建立 rate limit 記錄
  let record = rateLimitStore.get(sessionId);
  
  if (!record || now > record.resetAt) {
    // 新記錄或已過期，重置
    record = {
      count: 0,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    };
  }
  
  record.count++;
  rateLimitStore.set(sessionId, record);
  
  // 檢查是否超過限制
  if (record.count > RATE_LIMIT_REQUESTS) {
    const resetInSeconds = Math.ceil((record.resetAt - now) / 1000);
    console.warn(`[Rate Limit] Blocked request from ${sessionId} - ${record.count}/${RATE_LIMIT_REQUESTS}`);
    return res.status(429).json({
      error: `請求次數過多，請於 ${resetInSeconds} 秒後再試`,
      retryAfter: resetInSeconds
    });
  }
  
  next();
});

// 掛載 API 路由
app.use('/api', chatRouter);

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeSessions: getActiveSessionCount()
  });
});

// 404 處理
app.use((req, res) => {
  res.status(404).json({
    error: '找不到請求的資源',
    path: req.path
  });
});

// 錯誤處理中介層
app.use((err, req, res, next) => {
  console.error('[錯誤]', err);
  
  res.status(err.status || 500).json({
    error: err.message || '伺服器發生錯誤',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`\n🚀 伺服器已啟動於 http://localhost:${PORT}`);
  console.log(`📝 API 端點: http://localhost:${PORT}/api/chat`);
  console.log(`💚 健康檢查: http://localhost:${PORT}/health\n`);
});

// 定期清理過期會話（每分鐘執行一次）
const CLEANUP_INTERVAL_MS = 60 * 1000; // 1 分鐘
setInterval(() => {
  cleanupExpiredSessions();
}, CLEANUP_INTERVAL_MS);

// 優雅關閉
process.on('SIGTERM', () => {
  console.log('\n📦 收到 SIGTERM 訊號，正在關閉伺服器...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('\n📦 收到 SIGINT 訊號，正在關閉伺服器...');
  process.exit(0);
});
