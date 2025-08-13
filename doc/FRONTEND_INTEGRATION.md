## FRKB API 前端对接文档（指纹 SHA256）

本文档面向前端接入与联调，所有“指纹”均指 64 位十六进制的 SHA256 小写字符串；数组参数必须去重。

### 基本信息
- **基础前缀**: `/frkbapi/v1/fingerprint-sync`
- **数据对象**: 指纹（fingerprint）= 64 位十六进制 SHA256，小写
- **内容类型**: `Content-Type: application/json; charset=utf-8`
- **请求体大小上限**: 10MB
- **权限模型**:
  - **认证**: `Authorization: Bearer <API_SECRET_KEY>`（服务端配置）
  - **userKey**: 前端在请求体中提供，必须通过白名单校验；不同接口需要 `canSync`/`canQuery` 权限
- **限流**: 返回标准 `RateLimit-*` 响应头（`RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`），被限流时返回 `429` 且响应体含 `retryAfter`（秒）。同步类接口默认约 30/min（可配置）。

### 错误响应（统一）## FRKB API 前端对接文档（指纹 SHA256）

本文档面向前端接入与联调，所有“指纹”均指 64 位十六进制的 SHA256 小写字符串；数组参数必须去重。

### 基本信息
- **基础前缀**: `/frkbapi/v1/fingerprint-sync`
- **数据对象**: 指纹（fingerprint）= 64 位十六进制 SHA256，小写
- **内容类型**: `Content-Type: application/json; charset=utf-8`
- **请求体大小上限**: 10MB
- **认证模型**:
  - **认证**: `Authorization: Bearer <API_SECRET_KEY>`（服务端配置）
  - **userKey**: 前端在请求体中提供，必须通过白名单校验；仅区分启用/禁用
- **限流**: 返回标准 `RateLimit-*` 响应头（`RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`），被限流时返回 `429` 且响应体含 `retryAfter`（秒）。同步类接口默认约 30/min（可配置）。

### 错误响应（统一）
- 成功: `{ success: true, data }`
- 失败: `{ success: false, error, message, details?, timestamp, requestId? }`
- **常见错误码**:
  - `INVALID_FINGERPRINT_FORMAT`: 指纹格式非法（必须为 64hex，小写；数组内不得包含重复项）
  - `DIFF_SESSION_NOT_FOUND`: 差异会话不存在或已过期（HTTP 404；响应体可含 `retryAfter`，单位秒）
  - `DIFF_SESSION_USER_MISMATCH`: `userKey` 与会话不匹配（HTTP 403）
  - 限流类（HTTP 429）: `RATE_LIMIT_EXCEEDED` / `STRICT_RATE_LIMIT_EXCEEDED` / `SYNC_RATE_LIMIT_EXCEEDED` / `QUERY_RATE_LIMIT_EXCEEDED`

---

## 接口与参数说明（逐端点就近给出参数）

### 0) 校验 userKey（只读）
POST `/frkbapi/v1/fingerprint-sync/validate-user-key`

- **请求头**: `Authorization: Bearer <API_SECRET_KEY>`
- **请求参数**:
  - `userKey` (string, 必填): 用户标识（UUID v4）
- **成功返回字段**:
  - `success` (boolean): 是否成功
  - `data.userKey` (string): 标准化后的 userKey
  - `data.isActive` (boolean): 是否启用
  - `data.description` (string): 描述
  - `data.lastUsedAt` (string|null): 最近使用时间（ISO8601）
  - `performance.validateDuration` (number): 校验耗时（毫秒）
  - `timestamp` (string): 服务端时间戳（ISO8601）
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "userKey": "xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx",
    "isActive": true,
    
    "description": "渠道A-设备同步",
    "lastUsedAt": null
  },
  "performance": { "validateDuration": 3 },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```
- **说明**: 仅用于快速校验 userKey 是否存在且可用，不更新使用统计与配额。
 - **可能的错误**:
   - `400 INVALID_USER_KEY`: `userKey` 缺失或格式非法
   - `404 USER_KEY_NOT_FOUND`: 白名单不存在
   - `403 USER_KEY_INACTIVE`: 已禁用

- **错误响应（示例）**:
```json
{
  "success": false,
  "error": "USER_KEY_NOT_FOUND",
  "message": "userKey未找到或未授权",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### 1) 预检查集合一致性
POST `/frkbapi/v1/fingerprint-sync/check`

- **请求参数**:
  - `userKey` (string, 必填): 用户标识（UUID v4）
  - `count` (number, 必填): 客户端指纹数量（去重后）
  - `hash` (string, 必填): 客户端集合哈希（对“去重+小写”的集合进行顺序无关哈希）
- **成功返回字段**:
  - `success` (boolean)
  - `data.serverStats.totalFingerprintCount` (number): 服务器端总量
  - `data.clientStats.count` (number): 客户端提供的数量
  - `data.hashMatched` (boolean): 客户端集合哈希是否与服务端一致
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "serverStats": { "totalFingerprintCount": 52345 },
    "clientStats": { "count": 50000 },
    "hashMatched": false
  }
}
```
- **说明**: 仅用于快速判断是否需要进入差异分析；不改变服务端数据。
 - **可能的错误**:
   - `400 INVALID_USER_KEY`/参数校验错误（`count`、`hash`）
   - `401 INVALID_API_KEY`: API 密钥缺失/错误
   - `429 QUERY_RATE_LIMIT_EXCEEDED` 或 `SYNC_RATE_LIMIT_EXCEEDED`: 触发限流

- **错误响应（示例）**:
```json
{
  "success": false,
  "error": "INVALID_API_KEY",
  "message": "缺少Authorization头",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

或：参数校验失败（示意）
```json
{
  "success": false,
  "error": "VALIDATION_ERROR",
  "message": "请求参数验证失败",
  "details": {
    "errors": [
      { "field": "count", "message": "集合数量不能为空" },
      { "field": "hash", "message": "集合哈希值必须是64位字符" }
    ]
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### 2) 双向差异（分批，上行子集）
POST `/frkbapi/v1/fingerprint-sync/bidirectional-diff`

- **请求参数**:
  - `userKey` (string, 必填)
  - `clientFingerprints` (string[], 必填): 本批客户端指纹，长度 1..1000；数组必须“去重+小写”
  - `batchIndex` (number, 必填): 当前批次索引（从 0 开始）
  - `batchSize` (number, 必填): 批大小（建议固定 1000）
- **成功返回字段**:
  - `success` (boolean)
  - `data.batchIndex` (number): 当前批次索引
  - `data.batchSize` (number): 批大小
  - `data.serverMissingFingerprints` (string[]): 本批中“服务端缺失”的指纹
  - `data.serverExistingFingerprints` (string[]): 本批中“服务端已存在”的指纹
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "batchIndex": 0,
    "batchSize": 1000,
    "serverMissingFingerprints": ["a1...", "b2..."],
    "serverExistingFingerprints": ["c3...", "d4..."]
  }
}
```
- **说明**: `serverMissingFingerprints` 为“本批次中服务器缺失”的子集；前端可累积用于后续 `/add`。
 - **可能的错误**:
   - `400 INVALID_USER_KEY`/`INVALID_FINGERPRINT_FORMAT`/参数校验错误
   - `401 INVALID_API_KEY`
   - `429 SYNC_RATE_LIMIT_EXCEEDED`

- **错误响应（示例）**:
```json
{
  "success": false,
  "error": "SYNC_RATE_LIMIT_EXCEEDED",
  "message": "同步请求过于频繁，请稍后再试",
  "details": { "windowMs": 60000, "maxRequests": 30, "retryAfter": 60 },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

HTTP 响应头（示例）：
```http
RateLimit-Limit: 30
RateLimit-Remaining: 0
RateLimit-Reset: 60
Retry-After: 60
```

或：参数校验失败（示意）
```json
{
  "success": false,
  "error": "VALIDATION_ERROR",
  "message": "请求参数验证失败",
  "details": {
    "errors": [
      { "field": "clientFingerprints", "message": "clientFingerprints包含重复项: 索引12, 索引45" },
      { "field": "batchIndex", "message": "批次索引不能为空" }
    ]
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### 3) 一次性差异分析（生成会话）
POST `/frkbapi/v1/fingerprint-sync/analyze-diff`

- **请求参数**:
  - `userKey` (string, 必填)
  - `clientFingerprints` (string[], 必填): 客户端全量指纹（最多 100000，数组需去重+小写）
- **成功返回字段**:
  - `success` (boolean)
  - `data.diffSessionId` (string): 差异会话 ID（后续分页拉取使用）
  - `data.stats.clientMissingCount` (number): 客户端缺失数量（需要从服务端拉取）
  - `data.stats.serverMissingCount` (number): 服务端缺失数量（需要客户端上行 `/add`）
  - `data.pageInfo.pageSize` (number): 建议分页大小
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "diffSessionId": "diff_1700000000_abcd123",
    "stats": {
      "clientMissingCount": 1234,
      "serverMissingCount": 567
    },
    "pageInfo": {
      "pageSize": 1000
    }
  }
}
```
- **说明**:
  - `diffSessionId` TTL 5 分钟；格式校验为 `/^diff_[a-z0-9_]+$/i`；需与相同 `userKey` 一致使用。
  - 后续分页从 `missingInClient`（客户端缺失）中拉取，顺序在会话内稳定。
 - **可能的错误**:
   - `400 INVALID_USER_KEY`/`INVALID_FINGERPRINT_FORMAT`/请求体过大(`REQUEST_TOO_LARGE`)
   - `401 INVALID_API_KEY`
   - `429 STRICT_RATE_LIMIT_EXCEEDED`

- **错误响应（示例）**:
```json
{
  "success": false,
  "error": "STRICT_RATE_LIMIT_EXCEEDED",
  "message": "敏感操作请求过于频繁，请稍后再试",
  "details": { "retryAfter": 300 },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

或：请求体过大（示意）
```json
{
  "success": false,
  "error": "REQUEST_TOO_LARGE",
  "message": "请求体大小超过限制（最大10MB）",
  "details": { "currentSize": "13.27MB", "maxSize": "10MB" },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### 4) 分页拉取客户端缺失项
POST `/frkbapi/v1/fingerprint-sync/pull-diff-page`

- **请求参数**:
  - `userKey` (string, 必填)
  - `diffSessionId` (string, 必填): 来自 `/analyze-diff` 的会话 ID
  - `pageIndex` (number, 必填): 页索引（从 0 开始）
- **成功返回字段**:
  - `success` (boolean)
  - `data.sessionId` (string): 会话 ID（回显）
  - `data.missingFingerprints` (string[]): 本页客户端缺失、需要拉取到本地的指纹
  - `data.pageInfo.currentPage` (number): 当前页索引
  - `data.pageInfo.pageSize` (number): 页大小
  - `data.pageInfo.totalPages` (number): 总页数
  - `data.pageInfo.hasMore` (boolean): 是否有下一页
  - `data.pageInfo.totalCount` (number): 总缺失数量
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "sessionId": "diff_1700000000_abcd123",
    "missingFingerprints": ["001...", "00a...", "0ff..."],
    "pageInfo": {
      "currentPage": 0,
      "pageSize": 1000,
      "totalPages": 25,
      "hasMore": true,
      "totalCount": 24567
    }
  }
}
```
- **可能的错误**:
  - `404 + DIFF_SESSION_NOT_FOUND`: 会话不存在或过期；响应体可含 `retryAfter`（秒），需重新执行 `/analyze-diff`。
  - `403 + DIFF_SESSION_USER_MISMATCH`: 当前 `userKey` 与会话不匹配。
- **说明**:
  - 数据来源固定为会话内的 `missingInClient`，会话内页序稳定；页内按 `fingerprint` 升序。
  - 客户端应将 `missingFingerprints` 去重后合入本地“临时集合”，提交阶段再进行原子替换。
 - **可能的错误**:
   - `404 DIFF_SESSION_NOT_FOUND`: 会话不存在/过期（响应体可能含 `retryAfter` 秒）
   - `403 DIFF_SESSION_USER_MISMATCH`: 当前 `userKey` 与会话不匹配
   - 其余同上：`400` 参数/格式、`401` 鉴权、`429` 限流

- **错误响应（示例）**:
```json
{
  "success": false,
  "error": "DIFF_SESSION_NOT_FOUND",
  "message": "差异会话不存在或已过期",
  "retryAfter": 15,
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

或：会话用户不匹配（示意）
```json
{
  "success": false,
  "error": "DIFF_SESSION_USER_MISMATCH",
  "message": "当前 userKey 与会话不匹配",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

### 5) 批量新增（上行）
POST `/frkbapi/v1/fingerprint-sync/add`

- **请求参数**:
  - `userKey` (string, 必填)
  - `addFingerprints` (string[], 必填): 长度 1..1000；数组必须“去重+小写”，否则 400
- **成功返回字段**:
  - `success` (boolean)
  - `data.insertedCount` (number): 实际新增数量
  - `data.duplicateCount` (number): 已存在而跳过的数量
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "insertedCount": 998,
    "duplicateCount": 2
  }
}
```
- **说明**:
  - 幂等由唯一索引 `{ userKey, fingerprint }` 保证。
  - `duplicateCount` 仅统计“服务器已存在”的重复；若请求体内存在重复项，直接 400 校验错误（客户端需提交前去重）。
 - **可能的错误**:
   - `400 INVALID_FINGERPRINT_FORMAT`/请求体重复项/参数校验错误
   - `401 INVALID_API_KEY`
   - `429 SYNC_RATE_LIMIT_EXCEEDED`

- **错误响应（示例）**:
```json
{
  "success": false,
  "error": "INVALID_FINGERPRINT_FORMAT",
  "message": "指纹数组内存在重复或非64位十六进制",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

或：参数校验失败（示意）
```json
{
  "success": false,
  "error": "VALIDATION_ERROR",
  "message": "请求参数验证失败",
  "details": {
    "errors": [
      { "field": "addFingerprints", "message": "addFingerprints包含无效项: 索引3: 长度必须为64个字符（SHA256）" }
    ]
  },
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

---

## 典型同步流程（伪代码）
```ts
async function syncAll(userKey: string, clientFingerprints: string[]) {
  // 0) 预处理：去重 + 小写
  clientFingerprints = Array.from(new Set(clientFingerprints.map(s => s.toLowerCase())));

  // 1) 预检查
  const hash = sha256OfSet(clientFingerprints);
  const check = await post('/check', { userKey, count: clientFingerprints.length, hash });
  if (check.data.hashMatched) return;

  // 2) 分批上行差异（可选）
  const toAdd: string[] = [];
  const batchSize = 1000;
  for (let i = 0; i < clientFingerprints.length; i += batchSize) {
    const batch = clientFingerprints.slice(i, i + batchSize);
    const diff = await post('/bidirectional-diff', { userKey, clientFingerprints: batch, batchIndex: Math.floor(i / batchSize), batchSize });
    toAdd.push(...diff.data.serverMissingFingerprints);
  }

  // 3) 一次性差异分析 + 分页拉取
  const analysis = await post('/analyze-diff', { userKey, clientFingerprints });
  const sessionId = analysis.data.diffSessionId;
  const pageSize = analysis.data.pageInfo.pageSize;
  const totalPages = Math.ceil(analysis.data.stats.clientMissingCount / pageSize);

  for (let p = 0; p < totalPages; p++) {
    const page = await post('/pull-diff-page', { userKey, diffSessionId: sessionId, pageIndex: p });
    mergeIntoMemorySet(page.data.missingFingerprints);
  }

  // 4) 提交阶段：先上行新增，再本地原子替换
  for (let i = 0; i < toAdd.length; i += batchSize) {
    const slice = toAdd.slice(i, i + batchSize);
    if (slice.length) await post('/add', { userKey, addFingerprints: slice });
  }

  atomicReplaceLocalFile();
}
```

---

## 接入建议
- **数组去重与小写**: 所有 `string[]` 指纹数组必须先去重并转小写，否则将被 400 拒绝。
- **分页与重试**: `/pull-diff-page` 在会话内顺序稳定，可安全重试；若 404 + `DIFF_SESSION_NOT_FOUND`，根据 `retryAfter` 重建会话并重跑。
- **限流处理**: 收到 429 时，优先读取 `Retry-After` 与 `RateLimit-Reset`，按秒级退避；重要操作做好幂等。
- **提交顺序**: 推荐“先 `/add`，再本地原子替换”，避免本地状态与服务端短暂不一致。
- **安全**: 确保 `API_SECRET_KEY` 仅在安全环境下使用，`userKey` 由后端发放与白名单控制。

---

## 术语与格式校验
- **指纹格式**: `^[a-f0-9]{64}$`（服务端大小写不敏感，但推荐前端统一小写）
- **会话 ID**: `^diff_[a-z0-9_]+$`（区分用户；TTL 5 分钟）
- **请求体大小**: 10MB；`/analyze-diff` 的 `clientFingerprints` ≤ 100000；`/add` 与分批接口 ≤ 1000/批

---

## 附录：统一响应头（限流）
- `RateLimit-Limit`: 窗口内最大请求数
- `RateLimit-Remaining`: 窗口内剩余请求数
- `RateLimit-Reset`: 距离窗口重置的秒数
- `Retry-After`: 建议重试等待秒数（当 429 时）

如需更多示例或 SDK 封装，请告知使用语言与框架，我们将补充示例代码与错误处理模板。

- 成功: `{ success: true, data }`
- 失败: `{ success: false, error, message, details?, timestamp, requestId? }`
- **常见错误码**:
  - `INVALID_FINGERPRINT_FORMAT`: 指纹格式非法（必须为 64hex，小写；数组内不得包含重复项）
  - `DIFF_SESSION_NOT_FOUND`: 差异会话不存在或已过期（HTTP 404；响应体可含 `retryAfter`，单位秒）
  - `DIFF_SESSION_USER_MISMATCH`: `userKey` 与会话不匹配（HTTP 403）
  - `RATE_LIMITED`: 超过限流（HTTP 429；响应体含 `retryAfter`）

---

## 接口与参数说明（逐端点就近给出参数）

### 1) 预检查集合一致性
POST `/frkbapi/v1/fingerprint-sync/check`

- **请求参数**:
  - `userKey` (string, 必填): 用户标识（UUID v4）
  - `count` (number, 必填): 客户端指纹数量（去重后）
  - `hash` (string, 必填): 客户端集合哈希（对“去重+小写”的集合进行顺序无关哈希）
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "serverStats": { "totalFingerprintCount": 52345 },
    "clientStats": { "count": 50000 },
    "hashMatched": false
  }
}
```
- **说明**: 仅用于快速判断是否需要进入差异分析；不改变服务端数据。

---

### 2) 双向差异（分批，上行子集）
POST `/frkbapi/v1/fingerprint-sync/bidirectional-diff`

- **请求参数**:
  - `userKey` (string, 必填)
  - `clientFingerprints` (string[], 必填): 本批客户端指纹，长度 1..1000；数组必须“去重+小写”
  - `batchIndex` (number, 必填): 当前批次索引（从 0 开始）
  - `batchSize` (number, 必填): 批大小（建议固定 1000）
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "batchIndex": 0,
    "batchSize": 1000,
    "serverMissingFingerprints": ["a1...", "b2..."],
    "serverExistingFingerprints": ["c3...", "d4..."]
  }
}
```
- **说明**: `serverMissingFingerprints` 为“本批次中服务器缺失”的子集；前端可累积用于后续 `/add`。

---

### 3) 一次性差异分析（生成会话）
POST `/frkbapi/v1/fingerprint-sync/analyze-diff`

- **请求参数**:
  - `userKey` (string, 必填)
  - `clientFingerprints` (string[], 必填): 客户端全量指纹（最多 100000，数组需去重+小写）
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "diffSessionId": "diff_1700000000_abcd123",
    "stats": {
      "clientMissingCount": 1234,
      "serverMissingCount": 567
    },
    "pageInfo": {
      "pageSize": 1000
    }
  }
}
```
- **说明**:
  - `diffSessionId` TTL 5 分钟；格式校验为 `/^diff_[a-z0-9_]+$/i`；需与相同 `userKey` 一致使用。
  - 后续分页从 `missingInClient`（客户端缺失）中拉取，顺序在会话内稳定。

---

### 4) 分页拉取客户端缺失项
POST `/frkbapi/v1/fingerprint-sync/pull-diff-page`

- **请求参数**:
  - `userKey` (string, 必填)
  - `diffSessionId` (string, 必填): 来自 `/analyze-diff` 的会话 ID
  - `pageIndex` (number, 必填): 页索引（从 0 开始）
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "sessionId": "diff_1700000000_abcd123",
    "missingFingerprints": ["001...", "00a...", "0ff..."],
    "pageInfo": {
      "currentPage": 0,
      "pageSize": 1000,
      "totalPages": 25,
      "hasMore": true,
      "totalCount": 24567
    }
  }
}
```
- **可能的错误**:
  - `404 + DIFF_SESSION_NOT_FOUND`: 会话不存在或过期；响应体可含 `retryAfter`（秒），需重新执行 `/analyze-diff`。
  - `403 + DIFF_SESSION_USER_MISMATCH`: 当前 `userKey` 与会话不匹配。
- **说明**:
  - 数据来源固定为会话内的 `missingInClient`，会话内页序稳定；页内按 `fingerprint` 升序。
  - 客户端应将 `missingFingerprints` 去重后合入本地“临时集合”，提交阶段再进行原子替换。

---

### 5) 批量新增（上行）
POST `/frkbapi/v1/fingerprint-sync/add`

- **请求参数**:
  - `userKey` (string, 必填)
  - `addFingerprints` (string[], 必填): 长度 1..1000；数组必须“去重+小写”，否则 400
- **成功响应（示例）**:
```json
{
  "success": true,
  "data": {
    "insertedCount": 998,
    "duplicateCount": 2
  }
}
```
- **说明**:
  - 幂等由唯一索引 `{ userKey, fingerprint }` 保证。
  - `duplicateCount` 仅统计“服务器已存在”的重复；若请求体内存在重复项，直接 400 校验错误（客户端需提交前去重）。

---

## 典型同步流程（伪代码）
```ts
async function syncAll(userKey: string, clientFingerprints: string[]) {
  // 0) 预处理：去重 + 小写
  clientFingerprints = Array.from(new Set(clientFingerprints.map(s => s.toLowerCase())));

  // 1) 预检查
  const hash = sha256OfSet(clientFingerprints);
  const check = await post('/check', { userKey, count: clientFingerprints.length, hash });
  if (check.data.hashMatched) return;

  // 2) 分批上行差异（可选）
  const toAdd: string[] = [];
  const batchSize = 1000;
  for (let i = 0; i < clientFingerprints.length; i += batchSize) {
    const batch = clientFingerprints.slice(i, i + batchSize);
    const diff = await post('/bidirectional-diff', { userKey, clientFingerprints: batch, batchIndex: Math.floor(i / batchSize), batchSize });
    toAdd.push(...diff.data.serverMissingFingerprints);
  }

  // 3) 一次性差异分析 + 分页拉取
  const analysis = await post('/analyze-diff', { userKey, clientFingerprints });
  const sessionId = analysis.data.diffSessionId;
  const pageSize = analysis.data.pageInfo.pageSize;
  const totalPages = Math.ceil(analysis.data.stats.clientMissingCount / pageSize);

  for (let p = 0; p < totalPages; p++) {
    const page = await post('/pull-diff-page', { userKey, diffSessionId: sessionId, pageIndex: p });
    mergeIntoMemorySet(page.data.missingFingerprints);
  }

  // 4) 提交阶段：先上行新增，再本地原子替换
  for (let i = 0; i < toAdd.length; i += batchSize) {
    const slice = toAdd.slice(i, i + batchSize);
    if (slice.length) await post('/add', { userKey, addFingerprints: slice });
  }

  atomicReplaceLocalFile();
}
```

---

## 接入建议
- **数组去重与小写**: 所有 `string[]` 指纹数组必须先去重并转小写，否则将被 400 拒绝。
- **分页与重试**: `/pull-diff-page` 在会话内顺序稳定，可安全重试；若 404 + `DIFF_SESSION_NOT_FOUND`，根据 `retryAfter` 重建会话并重跑。
- **限流处理**: 收到 429 时，优先读取 `Retry-After` 与 `RateLimit-Reset`，按秒级退避；重要操作做好幂等。
- **提交顺序**: 推荐“先 `/add`，再本地原子替换”，避免本地状态与服务端短暂不一致。
- **安全**: 确保 `API_SECRET_KEY` 仅在安全环境下使用，`userKey` 由后端发放与白名单控制。

---

## 术语与格式校验
- **指纹格式**: `^[a-f0-9]{64}$`（服务端大小写不敏感，但推荐前端统一小写）
- **会话 ID**: `^diff_[a-z0-9_]+$`（区分用户；TTL 5 分钟）
- **请求体大小**: 10MB；`/analyze-diff` 的 `clientFingerprints` ≤ 100000；`/add` 与分批接口 ≤ 1000/批

---

## 附录：统一响应头（限流）
- `RateLimit-Limit`: 窗口内最大请求数
- `RateLimit-Remaining`: 窗口内剩余请求数
- `RateLimit-Reset`: 距离窗口重置的秒数
- `Retry-After`: 建议重试等待秒数（当 429 时）

如需更多示例或 SDK 封装，请告知使用语言与框架，我们将补充示例代码与错误处理模板。
