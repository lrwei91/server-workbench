# Server Workbench 项目总览

本项目当前采用 Node.js + FastAPI + 原生 ES Modules 双运行时，面向 Windows/PC 工具场景。Node 负责本地 HTTP、SSH、SFTP、HDFS 和 CDR 代理；FastAPI 负责话单内存模型。两者通过同源 `/cdr/` 代理连接，当前保持 SSH、SFTP、HDFS、日志和话单源文件格式兼容。

## 运行结构

```text
浏览器（PC）
  └─ Node server/server.js :17755
       ├─ public/ + shared/
       ├─ SSH / SFTP / HDFS
       ├─ 本地日志队列
       └─ /cdr/* 反向代理
            └─ FastAPI cdr/server.py :8000
                 └─ cdr/engine.py（最多 100,000 条内存记录）
```

`start.bat` 只从 PATH 查找 `node`、`python`/`py`，不包含个人绝对路径。`config.example.js` 展示结构，复制成未纳入 Git 的 `config.js` 后填写真实连接信息。Node 启动时会报告配置缺失，但不把凭据写入前端或日志。

## 前端架构

- `shared/tokens.css` 是纯白工具覆盖：画布/表面白、黑墨层级、荧光黄主操作与选中、蓝色焦点、独立状态色，视觉旋钮按 4/3/6 控制密度、圆角和阴影。
- `shared/ui.js` 提供统一请求错误模型、可区分的超时/主动取消、DOM 节点创建、状态播报、格式化和原生 `dialog` 焦点进入/恢复。
- `shared/icons.svg` 为图标精灵。主工作台和 CDR 前端均使用 `textContent`/节点构造渲染远端数据，不把文件名、路径、字段值拼入 `innerHTML`。
- 主工作台保持稳定 PC 双栏：左侧服务器文件/HDFS 浏览，右侧日志和命令；连接状态与主要操作集中在顶栏，引导仅在空态出现。
- 主工作台的三类资源列表在已加载数据上本地搜索/排序并保留收藏；HBase 查看窗口只读取指定行数的样本，查找和高亮不触发额外扫描。
- CDR 以「文件与会话 → 记录浏览 → 批量修改/造数 → 导出」顺序组织，字段错误、加载/空/错误状态和影响数量均在原位反馈。

当前默认聚焦 PC 场景，移动端专用布局和深色模式不属于默认实现范围；CSS 仅保留窄视口兜底，PC 缩放不应裁切主要操作。

## 后端契约与性能

### Node

- 请求体限制 1 MiB，非法 JSON/未知字段返回真实 HTTP 状态和 `{ok:false,error:{code,message,retryable}}`。
- `/api/exec` 是明确的高级自由命令入口；交互式命令和根目录递归强删拦截，删除类命令需 `confirmed:true`。所有参数化路径使用单引号 shell 转义。
- `/api/sftp/list|preview|mkdir|touch|delete|download` 使用结构化 SFTP；删除区分 file/空 dir，根路径保护。
- `/api/hdfs/list` 沿用后端一次重试，`/api/config` 将 HDFS 列表和 HBase 查询的实际执行时限下发给前端；`/api/hbase/scan` 保留原请求格式并返回 `truncated` 元数据。
- 命令 stdout/stderr 共用 2 MiB 预算并返回 `truncated`；日志通过异步队列写 JSONL，过期清理每天最多一次，读取支持 `limit/offset`，默认 200 条。
- 目录刷新、HDFS 刷新和自动刷新有 AbortController/代际门禁；页面隐藏时暂停，单个刷新请求不会重入。

### CDR

- `load_file` 逐行验证 NDJSON，只接受对象并在错误中报告行号；完整解析成功后才替换会话。
- 字段类型采用观察集合：整数+浮点推断为 float，字符串/其他混合推断为 str；ID 使用 O(1) 索引。
- 会话 revision 随修改递增，`GET /api/session` 支持刷新恢复；写操作可携带 `expected_revision`，冲突返回 409。
- 批量预览与实际应用共用转换/时间校验；无筛选的批量修改拒绝执行。造数先计算总量，超过 100,000 条拒绝；撤销栈有深度和变更预算。
- 导出先写同目录临时文件，验证 JSON 可读、`TICKET_COUNT`、ID 唯一性和时间格式，全部通过后 `os.replace` 原子替换。

## 测试与限制

Node builtin tests 覆盖 shell 转义、危险删除、真实错误状态、日志分页；Python unittest 覆盖非法 NDJSON、混合类型、ID 生成、批量一致性、版本/容量/原子导出等。测试使用假数据和临时目录，不接触真实凭据。

浏览器验收按受影响流程和布局变化选择环境，规则见 [AGENTS.md](./AGENTS.md)。真实 SSH/SFTP/HDFS smoke 需要本机 `config.js` 和已安装 `ssh2`。
