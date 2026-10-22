# Redis 缺失号码索引补建

入口：左侧「Redis 档案」→「新增缺失的号码索引 key」。本功能与 PG → Redis 字段/订购同步相互独立，不生成完整 `rate:cpp` 档案。

## 使用

1. 选择「产品实例 ID / rate:cpp 主键」或「手机号 / 接入号码（acc_nbr）」，输入值后点击「查询并预览」。手机号先读同一 Redis DB 的 `rate:accNbr` SET；索引缺失时使用已连接的测试 PG `bill_inmemory.prod_inst.acc_nbr` 定位，最多 100 个候选，超过时请用实例 ID。PG 查询失败与无结果分别呈现，不静默换到工程环境。
2. 单实例自动预览；多个候选需选择实例并点击「预览所选实例」。根 CPP 缺失或编码异常时停止补建。仅使用 `prodInsts` 中与 CPP key 相符的根产品行，保留现存历史版本，不从 SecondStep 关联产品推断。
3. 核对每个目标 key、来源字段、区号和 `servId`。`rate:account:<account>` 取根产品的 `account`，`rate:accNbr:<accNbr>` 取根产品的 `accNbr`；二者不互相替代，缺失字段会提示。相同成员去重，同一实例的不同区域/历史字段值分别保留。
4. 点击「确认新增缺失 key」，在二次确认框确认。后台生成数值型 `servId` 的 JSON，经 Kryo String 和 LZ4 block 编码，使用二进制 SET member，不复制界面乱码文本。新 key 永久有效（无 TTL），既有 key、成员、TTL 和源 CPP 保持原样。

## 范围与并发

- 仅创建预览时不存在的整个 key；已有 key 即使类型错误或成员有缺口，也仅展示并保留，不执行成员追加、修复、覆盖或删除。
- 范围仅为用户选定实例，不扫描 Redis 全库，也不宣称包含共享号码对应的所有其他实例。需要共享号码全成员重建时，应使用完整档案生成链核对范围。
- 预览有效期 10 分钟且绑定 Redis 连接；输入/候选变化会清理前端预览，取消只作用于只读查询。确认时按 token 使用服务端候选，不接受浏览器传入任意 key/member。
- Lua 在写入前一次核对源 CPP 字节及所有目标仍缺失；源变化或任一目标出现时，整次新增停止。使用现有 Redis 直连配置，未新增 Redis Cluster 跨槽支持。
- 写前将源摘要、目标成员与编码记录到本地 `logs/redis-indexes/<auditId>.json`（实际位置跟随日志目录配置），包含号码等档案数据，需按本地日志管理。新增成功后逐 key 回读、解码并校验全部成员；操作记录状态为 `verified`。
- 写入响应丢失或回读异常时记录 `uncertain`，写入 token 已消耗，不自动重放；先重新查询当前 key 状态，再判断后续处理。本功能没有自动删除/回滚按钮，避免误删后续成员。

## 接口

- `POST /api/redis-index/lookup`：`{inputType: "instance" | "phone", value: "..."}`。
- `POST /api/redis-index/preview`：`{productInstanceId: "..."}`，只读预览。
- `POST /api/redis-index/apply`：`{previewId: "...", confirmed: true}`，同源校验、明确确认、创建及回读。

Node 测试使用本地 RESP fixture 与模拟 PG，不写真实 Redis；真实采预端到端运行属于单独验收。
