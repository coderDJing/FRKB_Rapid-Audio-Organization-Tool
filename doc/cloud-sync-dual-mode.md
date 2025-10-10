# 云同步双指纹模式对接说明

## 背景
客户端支持两种指纹模式并行存在：
- pcm：对解码后的 PCM 内容做 SHA256（可忽略封面/标签等元信息）
- file：对整文件字节做 SHA256（无解码，速度快）

两套模式互不兼容，云端需按 `mode` 维度进行命名空间隔离（计数、配额、增删、校验均分离）。

## 通用约定
- 所有接口请求体均需携带：`userKey: string`、`mode: 'pcm' | 'file'`
- 指纹统一为 64 位小写 hex 的 SHA256
- Header：`Authorization: Bearer <API_SECRET_KEY>`

## 接口契约

### 1) 校验用户 Key
POST `/frkbapi/v1/fingerprint-sync/validate-user-key`

Request:
```json
{ "userKey": "..." }
```
Response:
```json
{ "success": true, "data": { "isActive": true, "userKey": "..." }, "limit": 500000 }
```

### 2) 集合校验 /check
POST `/frkbapi/v1/fingerprint-sync/check`

Request:
```json
{ "userKey": "...", "count": 1234, "hash": "...", "mode": "pcm" }
```
Response:
```json
{ "success": true, "needSync": true, "serverCount": 1000, "clientCount": 1234, "limit": 500000 }
```

### 3) 双向差异（分批）/bidirectional-diff
POST `/frkbapi/v1/fingerprint-sync/bidirectional-diff`

Request:
```json
{ "userKey": "...", "clientFingerprints": ["..."], "batchIndex": 0, "batchSize": 1000, "mode": "file" }
```
Response:
```json
{ "success": true, "serverMissingFingerprints": ["..."] }
```

### 4) 汇总分析 /analyze-diff
POST `/frkbapi/v1/fingerprint-sync/analyze-diff`

Request:
```json
{ "userKey": "...", "clientFingerprints": ["..."], "mode": "pcm" }
```
Response:
```json
{ "success": true, "diffSessionId": "...", "diffStats": { "clientMissingCount": 123, "pageSize": 1000 } }
```

### 5) 拉取缺失分页 /pull-diff-page
POST `/frkbapi/v1/fingerprint-sync/pull-diff-page`

Request:
```json
{ "userKey": "...", "diffSessionId": "...", "pageIndex": 0, "mode": "pcm" }
```
Response:
```json
{ "success": true, "missingFingerprints": ["..."] }
```

### 6) 批量新增 /add
POST `/frkbapi/v1/fingerprint-sync/add`

Request:
```json
{ "userKey": "...", "addFingerprints": ["..."], "mode": "file" }
```
Response:
```json
{ "success": true, "addedCount": 1000 }
```

## 错误码约定（示例）
- INVALID_API_KEY, INVALID_USER_KEY, USER_KEY_NOT_FOUND, USER_KEY_INACTIVE
- REQUEST_TOO_LARGE, VALIDATION_ERROR
- RATE_LIMIT_EXCEEDED, SYNC_RATE_LIMIT_EXCEEDED
- FINGERPRINT_LIMIT_EXCEEDED（按 `mode` 维度计数）

## 配额
- `limit` 表示该 `userKey` 在某个 `mode` 下可存储的指纹上限；不同 `mode` 各自独立。

## 备注
- 客户端切换 `mode` 不清空另一套的云端数据与本地 token；仅同步当前模式。
- 旧库检测到后，客户端会静默清除旧式本地指纹；云端清理与否由后端在本次版本上线时统一处理。
