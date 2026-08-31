# Server Workbench

面向测试人员的本地 Web 远程服务器管理工作台。通过浏览器完成 SSH 命令执行、SFTP 文件浏览、HDFS 浏览、执行日志留存，以及计费测试话单的浏览、改数、造数和导出校验。

> 工作台仅监听 `127.0.0.1`。远程服务器地址、账号和密码保存在本地 `config.js` 中，该文件已被 `.gitignore` 排除。

## 主要功能

- **SSH 工作台**：连接远程服务器、执行常用或自定义命令。
- **SFTP 文件浏览**：浏览目录、查看和下载文件、新建文件或目录。
- **HDFS 浏览**：可视化浏览 HDFS 目录、预览和下载文件。
- **执行日志**：按日期保存命令、结果和耗时，支持恢复与导出。
- **计费速查**：集中查看常用 HDFS 路径、话单表、HBase 表和服务信息。
- **话单工具**：加载、筛选、修改和批量生成测试话单，导出时执行完整性校验。

## 技术结构

```text
浏览器
  └─ Node.js 本地桥接服务（127.0.0.1:17755）
       ├─ SSH / SFTP / HDFS
       ├─ 静态页面 public/
       └─ /cdr/ 反向代理
            └─ Python FastAPI 话单服务（127.0.0.1:8000）
```

```text
server-workbench/
├─ start.bat          # Windows 一键启动入口
├─ config.js          # 本地配置，不提交到 Git
├─ overview.md        # 完整功能、架构和验证记录
├─ public/            # 工作台前端
├─ server/            # Node.js 桥接服务
└─ cdr/               # Python FastAPI 话单模块
```

## 快速开始

### 1. 准备运行环境

- Windows 10/11
- Node.js 18 或更高版本
- Node.js 依赖：`ssh2`
- Python 3.10 或更高版本
- Python 依赖：见 `cdr/requirements.txt`
- 目标服务器可通过 SSH 访问；HDFS 功能还要求目标服务器可执行 `hadoop fs`

安装依赖：

```powershell
npm install ssh2
python -m pip install -r .\cdr\requirements.txt
```

### 2. 创建本地配置

在项目根目录创建 `config.js`：

```js
'use strict';

module.exports = {
  workbench: {
    host: '127.0.0.1',
    port: 17755,
  },
  ssh: {
    host: 'TARGET',
    port: 22,
    username: 'USERNAME',
    password: 'PASSWORD',
  },
  cdr: {
    host: '127.0.0.1',
    port: 8000,
  },
  logs: {
    dir: 'logs',
    maxDays: 90,
  },
  sshTimeoutMs: 15000,
  execTimeoutMs: 25000,
  execMaxTimeoutMs: 120000,
  hdfsTimeoutMs: 90000,
};
```

请勿将含真实凭据的 `config.js` 提交到仓库。

### 3. 启动

当前已配置环境可直接双击：

```text
start.bat
```

`start.bat` 中的 Node.js 和 Python 路径是本机路径；在其他电脑使用时，先按实际安装位置调整 `NODE_EXE`、`NODE_PATH` 和 `PY_EXE`。

也可以分别启动两个服务：

```powershell
$env:CDR_PORT = '8000'
python .\cdr\server.py
```

另开一个终端：

```powershell
node .\server\server.js
```

浏览器访问：<http://127.0.0.1:17755>

## 基本使用流程

1. 启动工作台并打开页面。
2. 点击右上角 **连接**，确认 SSH 连接成功。
3. 在 **服务器文件** 或 **HDFS** 页面浏览目标目录。
4. 通过 **快捷指令** 或底部输入框执行命令。
5. 通过 **计费速查** 查看常用路径、表和服务信息。
6. 通过 **话单工具** 加载、改数、造数并导出测试话单。
7. 在日志区核对执行结果并保存证据。

## 数据与安全说明

- 服务只监听本机回环地址，不直接对局域网或公网开放。
- 删除类命令需要二次确认，根目录递归删除会被拦截。
- 话单源文件保持只读；修改内容仅存在于内存，导出时才写入输出目录。
- `logs/` 与 `cdr/data/logs/` 可能包含业务信息，均已排除在版本控制之外。
- 首次使用前应检查 `config.js`、常用 HDFS 路径和计费速查数据是否适用于当前环境。

## 更多文档

- [项目总览与完整实现说明](./overview.md)
- [话单工具使用说明](./cdr/README.md)

