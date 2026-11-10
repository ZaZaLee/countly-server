# 自研 Drill 插件设计方案

## 1. 目标与范围

本文档记录基于当前 Countly Lite 代码实现的自研 Drill 插件方案与第一版状态。插件保存进入 Countly 事件处理流程的原始事件，并提供通用查询 UI、游标分页和 CSV 导出。

目标：

- 以 Countly 插件形式实现，尽量不修改现有核心逻辑。
- 使用独立的 `countly_drill` MongoDB 数据库。
- 不影响现有 `countly.events_data` 聚合、收入统计、用户统计和 SDK 接收链路。
- 参考官方 Drill 的字段、集合和查询语义，保留未来迁移或兼容的可能性。
- 首版完成旁路明细存储、事件查询 UI、用户/设备/分群字段过滤、游标分页和 CSV 导出。
- 后续迭代再实现漏斗、用户路径和更完整的官方 Drill 行为兼容。

非目标：

- 第一阶段不复制官方 Enterprise Drill 的前端和私有实现。
- 首版不实现漏斗、用户旅程、路径分析等跨事件高级功能。
- 不试图恢复插件启用前已经丢失的历史原始事件。

## 2. 当前架构结论

### 2.1 数据库职责

| 数据库 | 主要用途 | 是否适合逐条事件 |
| --- | --- | --- |
| `countly` | 应用、用户、事件定义、聚合统计、业务插件数据 | 不适合 |
| `countly_fs` | GridFS 文件、导出文件、任务结果 | 不适合 |
| `countly_out` | 可选外部输出数据 | 不作为本方案存储 |
| `countly_drill` | Drill 原始事件和辅助元数据 | 适合 |

`countly.events_data` 使用 `$inc` 保存按时间和分段聚合的计数、收入和时长，例如 `d.8.c`、`d.8.s`。它不包含每条事件的唯一 ID、完整事件时间和事件属性组合，因此不能还原原始事件。

`countly_fs` 是 GridFS 文件存储，也不是事件明细库。

### 2.2 事件入口

`countly-server/api/parts/data/events.js` 会遍历请求中的 `events`，并为每个事件调用：

```javascript
plugins.dispatch("/i/events", {
    params: params,
    currEvent: currEvent
});
```

Revenue 插件已经使用这个钩子处理支付事件，因此它适合做通用原始事件归档入口。

该入口的语义是：保存已经通过基本检查、进入 Countly 正常事件处理流程的事件，而不是保存所有到达 HTTP 层的原始请求。网络失败、JSON 解析失败、缺少必要字段、被事件数量限制拒绝的事件不会完整进入该入口。

### 2.3 数据库连接

当前 `pluginManager` 会在官方 `plugins/drill` 存在时连接 `countly_drill`；本次实现扩展为：自研 `plugins/custom-drill` 目录存在且 `custom-drill` 在启用插件清单中时也连接该库。未启用自研插件时不会尝试连接新库，避免对现有 Countly 部署产生权限依赖。API 启动时先连接数据库，再创建批量器，最后初始化插件，因此插件可以复用已建立的 `common.drillDb`，避免自行管理 MongoClient 生命周期。

## 3. 总体架构

```text
Countly SDK 请求
        |
        v
Countly requestProcessor
        |
        v
events.processEvents
        |
        +-------------------------------+
        |                               |
        v                               v
现有 Countly 聚合链路                  自研 Drill 插件
        |                               |
        v                               v
countly.events_data               countly_drill.raw_events
                                        |
                                        +--> drill_meta
                                        +--> ingest_stats
                                        +--> 查询 API
                                        +--> 通用 UI
```

自研插件只复制事件并提供 Drill 数据服务，不修改现有聚合计算结果。

## 4. 插件结构

### 4.1 目录建议

实现使用 `custom-drill`，避免未来购买官方 Enterprise 版本时与官方 `drill` 目录冲突：

```text
countly-server/plugins/custom-drill/
├── package.json
├── install.js
├── api/api.js
├── frontend/
│   ├── app.js
│   └── public/
│       ├── javascripts/countly.views.js
│       └── templates/drill.html
```

核心自动连接 `countly_drill` 的条件已经扩展为：官方 `plugins/drill` 存在，或 `plugins/custom-drill` 存在且在插件启用清单中。自研插件继续复用 `common.drillDb`，不用维护独立 MongoClient 生命周期。

```javascript
common.drillDb // 由 pluginManager.connectToAllDatabases() 初始化
```

不建议因为方便复用连接逻辑而长期把自研代码命名成官方 `drill`。

### 4.2 插件启用

在 MongoDB 管理员已授予 Countly 账号 `countly_drill` 的 `readWrite` 权限后，才在镜像构建或容器启动时加入：

```yaml
COUNTLY_PLUGINS: mobile,web,desktop,...,data-manager,custom-drill
```

当前 Docker 脚本对名称为 `drill` 的插件有自动补充 `license` 的 Enterprise 逻辑。使用 `custom-drill` 可以避免触发该逻辑，但仍需要把插件代码复制进最终 Countly 镜像，并确认 `plugins.json` 中包含它。

## 5. 原始事件模型

### 5.1 主集合

第一阶段使用统一集合：

```text
countly_drill.raw_events
```

不按事件名拆集合，原因是事件名可能持续增长，通用查询需要跨事件查询，统一集合也更容易统一索引和保留策略。

如果数据量后续证明单集合无法满足性能，再按月拆分，例如：

```text
raw_events_2026_11
raw_events_2026_12
```

集合选择应封装在 Repository 层，不能让 UI 直接依赖集合名称。

### 5.2 文档结构

```javascript
{
  _id: ObjectId(),

  // 参考官方 Drill 的短字段
  a: "6a2a58358c36f369b13d0295",
  e: "v2_e_battle_settlement",
  ts: 1794096000000,
  uid: "player-id",
  did: "device-id",
  sg: {
    battle_is_win: true,
    level_id_new: 119
  },

  // 自研扩展字段
  app_id: "6a2a58358c36f369b13d0295",
  event: "v2_e_battle_settlement",
  event_time: ISODate("2026-11-08T16:00:00.000Z"),
  received_at: ISODate("2026-11-08T16:00:01.000Z"),
  count: 1,
  sum: 0,
  dur: 0,
  request_id: "request-id",
  event_index: 0,
  app_version: "1.0.0",
  platform: "android",
  raw_version: 1
}
```

字段含义：

| 字段 | 含义 |
| --- | --- |
| `a` | App 内部 ID |
| `e` | 事件名 |
| `ts` | 事件时间的毫秒时间戳 |
| `uid` | Countly 用户 UID |
| `did` | 设备 ID |
| `sg` | 事件 segmentation |
| `received_at` | 服务端接收时间 |
| `event_time` | 业务事件时间 |
| `count` | 当前事件条目的 Countly 计数值 |
| `sum` | 当前事件的数值和 |
| `dur` | 当前事件持续时间 |
| `request_id` | Countly 请求级标识 |
| `event_index` | 同一请求内的事件顺序 |
| `raw_version` | 文档格式版本 |

同时保留短字段和可读字段，兼顾官方字段兼容和后续维护。

### 5.3 `count` 语义

客户端如果上报：

```javascript
{ key: "some_event", count: 5 }
```

应保存一条原始文档，并记录 `count: 5`，不要展开成五条文档。查询页面同时展示：

- 明细文档数：收到多少个事件条目；
- 事件计数和：`sum(count)`，与 Countly 聚合口径接近。

这样可以区分“1 条 `count=5`”和“5 条 `count=1`”。

## 6. 元数据

集合：

```text
countly_drill.drill_meta
```

元数据用于驱动通用 UI，当前版本只保存字段名和最近出现时间，不保存所有高基数值；字段类型由查询结果中的样本值推断：

```javascript
{
  _id: "6a2a58358c36f369b13d0295:v2_e_battle_settlement",
  app_id: "6a2a58358c36f369b13d0295",
  event: "v2_e_battle_settlement",
  fields: ["battle_is_win", "level_id_new"],
  first_seen_at: ISODate("..."),
  last_seen_at: ISODate("..."),
  format_version: 1
}
```

元数据建议在进程内缓存后定时批量刷新，不要每条事件都大量更新。字段总数、字段名长度和候选值数量应设置上限。订单号、请求 ID 等高基数字段只记录“字段存在和类型”，不把所有值写进元数据。

## 7. 写入与故障隔离

### 7.1 批量异步写入

优先复用 Countly 现有 `InsertBatcher`，为 `countly_drill` 增加数据库连接和批量队列。每批通过 `insertMany` 写入，避免每条事件一次 MongoDB 网络往返。

建议初始配置：

| 参数 | 初始建议 |
| --- | ---: |
| 批量刷新间隔 | 1-5 秒 |
| 单批最大文档数 | 500-2000 |
| 内存队列上限 | 10000-50000 |
| 单文档最大大小 | 256 KB |
| UI 查询最长范围 | 7-31 天 |

正式值必须配置化，并通过压测调整。

### 7.2 主链路隔离

归档必须是旁路行为：

- 不等待 Drill 写入完成后再响应 SDK 请求；
- Drill 数据库不可用时，Countly 原有聚合继续工作；
- 队列满时优先保证主链路，可丢弃或采样 Drill 数据；
- 记录失败、重试、丢弃和队列长度指标；
- 对持续写入失败启用熔断，避免 Mongo 故障时制造大量错误。

这意味着第一阶段追求“尽量完整”，而不是绝对不丢。如果业务要求绝对不丢，需要持久化队列或同步确认，会增加耦合和主链路延迟，不符合当前目标。

### 7.3 多进程和退出

当前 Countly 使用 Node.js cluster。批量器要遵守现有 master/worker 消息转发机制，避免 worker 间共享不安全状态。进程退出时先尝试刷新 Drill 队列，但必须有超时，不能无限等待。

## 8. 索引与保留

当前实现创建以下索引：

```javascript
db.raw_events.createIndex({ a: 1, e: 1, ts: -1 });
db.raw_events.createIndex({ a: 1, uid: 1, ts: -1 });
db.raw_events.createIndex({ a: 1, did: 1, ts: -1 });
db.raw_events.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
```

TTL 示例为 30 天，生产值必须配置化。

不建议第一版为所有动态 `sg.*` 建索引。segmentation 字段和取值不可控，动态索引会增加写放大和存储压力。后续根据查询统计为热点属性加索引，例如：

```javascript
db.raw_events.createIndex({
  a: 1,
  e: 1,
  "sg.level_id_new": 1,
  ts: -1
});
```

MongoDB wildcard index 可以作为后续实验选项，但需要真实流量压测后决定。

## 9. 通用查询 API

UI 不直接访问 MongoDB，通过插件 API 访问。当前实现接口：

```text
GET  /o/custom-drill/events
GET  /o/custom-drill/query
GET  /o/custom-drill/export
GET  /o/custom-drill/health
```

查询请求示例：

```json
{
  "app_id": "6a2a58358c36f369b13d0295",
  "event": "v2_e_battle_settlement",
  "from": "2026-11-08T00:00:00+08:00",
  "to": "2026-11-09T00:00:00+08:00",
  "filters": [
    {"field": "sg.battle_is_win", "operator": "eq", "value": true},
    {"field": "sg.level_id_new", "operator": "gte", "value": 100}
  ],
  "page_size": 50,
  "cursor": null,
  "sort": {"field": "ts", "direction": "desc"}
}
```

当前实现支持白名单操作符：

```text
eq、ne、in、exists、gte、gt、lte、lt
```

不能把用户提交的 JSON 直接传给 MongoDB。字段、操作符、值类型、时间范围、分页大小都必须校验；禁止 `$where`、任意 JavaScript、任意 `$expr` 和未经允许的聚合阶段。Countly 代码仓库已有“拒绝不安全查询、不要静默修改查询”的约束，新的 API 应遵守同样原则。

优先使用游标分页，而不是深分页 `skip`。游标可以由 `(ts, _id)` 组成，避免数据量大时分页越来越慢。

## 10. 通用 UI

第一版页面结构：

1. 当前 App 和事件名；
2. 时间范围选择器；
3. 用户 ID、设备 ID 和一个 segmentation 字段过滤器；
4. 原始事件结果表；
5. 游标式 Load more；
6. CSV 导出按钮。

事件页「所有事件」右上角的 Drill 按钮在 `custom-drill` 启用且官方 `drill` 未启用时，会直接跳转到自研页面，并带入当前事件及时间范围。

属性类型与控件：

| 类型 | 控件 |
| --- | --- |
| `string` | 文本、等于、包含 |
| `number` | 最小值、最大值 |
| `boolean` | 是/否 |
| `date` | 时间范围 |
| 混合类型 | 精确匹配 |

高基数字段不能自动加载所有候选值。只有低基数属性才提供下拉选项。

后续汇总支持：

- 明细文档数；
- `sum(count)`；
- `sum(sum)`；
- 去重玩家数；
- 按小时、天和属性分组。

## 11. 官方 Drill 兼容策略

### 11.1 字段兼容

优先保留：

```text
a   App ID
e   Event name
ts  Event timestamp
uid User ID
did Device ID
sg  Segmentation
```

### 11.2 集合兼容

官方相关代码存在 `drill_events` 和按事件/App 哈希的 `drill_events<hash>` 集合约定。自研实现第一阶段仍建议使用 `raw_events`，通过 Repository 层提供兼容查询；如果以后需要迁移到官方结构，再增加导出/转换工具，而不是一开始绑定到大量集合。

### 11.3 功能兼容

官方 Drill 的 UI、查询构建器、书签、导出、推送人群和其他插件之间存在联动。仅集合名相同不能保证功能兼容。因此本方案的兼容目标是：

- 核心事件字段兼容；
- 按 App、事件、时间、用户和 segmentation 查询语义兼容；
- 预留 `drill_meta` 和查询 API；
- 将来可转换为官方 Drill 数据格式。

## 12. 权限与安全

Countly 运行账号需要：

```text
countly       现有读写权限
countly_fs    现有读写权限
countly_drill readWrite
```

不建议为运行账号增加 `root` 或整个集群管理员权限。火山托管 MongoDB 中，如果当前账号不能授予跨库角色，需要由实例管理员在控制台或管理员账号中配置。

查询 API 必须复用 Countly 的 App 权限校验，不能只相信前端传入的 `app_id`。原始数据可能包含用户 ID、设备 ID、订单号和自定义敏感字段，应提供字段脱敏、导出权限、查询审计、时间范围限制和最大返回数量限制。

## 13. 监控指标

至少记录：

```text
drill_ingest_received_total
drill_ingest_queued_total
drill_ingest_written_total
drill_ingest_failed_total
drill_ingest_dropped_total
drill_ingest_queue_size
drill_ingest_write_latency_ms
drill_query_total
drill_query_failed_total
drill_query_latency_ms
```

还应按 App 和事件名定期比较：

```text
Countly 聚合计数
Drill 原始文档数
Drill count 字段之和
去重玩家数
```

## 14. 分阶段实施

### 阶段一：存储与连接（已实现）

- `custom-drill` 插件通过 `/i/events` 异步归档可处理的自定义事件。
- 使用 `countly_drill.raw_events` 和 `drill_meta`，包含批量写入、TTL、队列上限和健康状态。
- `pluginManager` 仅在插件启用时连接该独立数据库。

### 阶段二：查询与首版 UI（已实现）

- 提供事件元数据列表、查询、健康检查和 CSV 导出 API。
- 查询进行 Countly App 读取权限校验，支持时间范围、用户/设备 ID 及 segmentation 条件。
- 以 `(ts, _id)` 为游标分页，限制时间范围、页大小及导出条数。
- 从「事件 → 所有事件」右上角 Drill 按钮直接进入，自带选中事件及所选日期范围。

### 阶段三：字段探索和聚合（待实现）

- 动态字段目录、类型探测、多字段组合过滤。
- 事件条数、`sum(count)`、`sum(sum)`、去重用户数和按时间分桶。

### 阶段四：漏斗与用户路径（待设计/实现）

- 明确 UID/DID 拼接、匿名用户和登录后身份处理、事件排序、会话边界和转换窗口。
- 对应 Mongo 聚合与 UI 需要评估数据规模、索引、查询限额及隐私权限。

### 阶段五：官方 Drill 兼容增强（待实现）

- 继续对齐字段语义和常用查询操作；如需迁移官方集合格式，先基于真实版本的官方数据结构做适配与验证。
- 不承诺直接兼容官方私有集合、插件内部接口或漏斗/路径的全部语义。

## 15. 风险与取舍

### MongoDB 资源压力

使用现有 MongoDB 不需要购买 ClickHouse，但会增加写入、索引、磁盘、备份和恢复压力。原始事件量通常远大于 `events_data` 聚合数据，必须设置保留期并监控磁盘增长。

### 归档完整性

异步旁路写入可以保护 Countly 主链路，但进程崩溃、队列溢出或 MongoDB 长时间不可用时可能丢失 Drill 记录。如果要求绝对不丢，需要持久化消息队列或同步确认，会增加主链路延迟和系统耦合。

### 官方兼容性

字段和查询模型可以参考官方 Drill，但官方 Enterprise 插件的完整功能存在跨插件依赖。自研实现应通过 Repository 层隔离底层结构，避免未来被某一种集合命名永久绑定。

## 16. 最终建议

正式方案建议如下：

1. 使用 `custom-drill` 插件名，避免与官方 `drill` 冲突。
2. 复用 `pluginManager` 提供的 `common.drillDb`，仅在插件启用时连接数据库。
3. 原始事件写入独立的 `countly_drill.raw_events`，保存官方风格字段 `a/e/ts/uid/did/sg` 和自研扩展字段。
4. 使用异步批量写入，确保归档故障不阻断 Countly 聚合链路。
5. 首版提供查询 UI、游标分页和有限 CSV 导出；漏斗、路径及深入兼容后续分阶段实现。

首版实现说明：自研插件不是官方 Enterprise Drill 的完整替代品；它不回填启用前数据，不与官方私有集合互写。数据库授权后还需把 `custom-drill` 加入 API 容器 `COUNTLY_PLUGINS` 并重启才能开始归档。

该方案能满足支付、广告、关卡结算等事件的逐条核查，也能为后续通用事件分析提供统一基础。
