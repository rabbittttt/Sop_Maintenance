# SOP 单一源码与门户接入

本仓库维护 SOP 的服务、页面和发布脚本。开发工作区把 `SOP维护` 和 `计划工作台` 放在 `Project` 下，门户通过固定前缀 `/sop/` 接入独立服务。

## 独立运行

原有 `启动工作台.cmd`、`start-sop.ps1` 和 `../.venv/Scripts/python.exe server.py --port 8876` 继续用于本机独立运行。启动器默认沿自身位置查找 `Project/.venv`，不依赖 Project 的上级路径。不传 `--gateway-config` 时仍使用本机 Host/Origin 校验、原有业务目录和维护人流程。

## 门户模式

`server.py --gateway-config <配置文件>` 显式启用前缀、同源嵌入和可信代理模式。配置包含 `base_path`、`public_origin`、`proxy_secret_env`、`allow_writes`，以及可选的 `data_dir`、`source_dir`、`shared_config`、`plan_file` 绝对路径。

`plan_file`、`--plan-file` 和 `SOP_PLAN_DIR` 仅保留旧配置兼容。当前服务不再监控、回读或生成服务器上的维护表，已有文件保留不动；计划以持久数据库为准，通过网页保存，或从页面导出 Excel、修改后再导入。`source_dir` 仍只选择销售输入。

SOP 网关校验可信代理和密钥，POST 还校验 Origin。PlanHub 的 Docker 发布版从包外 `planhub-runtime/config.json` 读取 `publicOrigin`、`sopSecret` 和 `sopSharedConfig`，启动时派生 `config/sop-local.json`。正式入口由公司认证网关核实部门访问资格，门户转发受信请求。后端 `allow_writes` 是全服务维护开关，门户正常运行时设为 `true`。网页保存、Excel 导入和个人视图采用外层系统传给 SOP 的账号；该账号用于业务署名。

源码联调从本仓库启动 Python，默认与独立入口共用 `../工作台数据/database/sop/`。发布包的 `preview.cmd` 和正式容器默认共用包外 `planhub-runtime/database/sop/`、共享来源及 `logs/sop/`；两种方式应先停一方再启动另一方。源码联调使用 `--snapshot`、发布包本机试运行使用 `preview.cmd -Snapshot` 时才创建隔离数据副本。

## 发布产物

从本项目运行 `../.venv/Scripts/python.exe scripts/build_release.py --destination <项目目录以外的全新绝对路径>` 构建 SOP 原始发布目录。非 Windows 环境使用 `../.venv/bin/python`。`sop-release.json` 记录源码提交、工作区状态和发布文件的 SHA-256。业务数据库、Excel、真实共享规则和机密由运行环境提供。

门户校验 `sop-release.json` 后，把 SOP 原包封装进交付目录的 `releases/sop/`。若只更新 SOP，在计划工作台使用 `发布应用.bat` 选择对应应用，在目标机切换和验证该应用版本。

## 验证与运维边界

Python 业务/HTTP/导入导出测试与 Node 前端测试在本仓库运行。门户中的相关测试只验证接入、启动参数、发布文件完整性和代理行为。测试使用隔离数据。

正式环境由部署人员配置公司认证入口、HTTPS、运行目录及部门访问边界，使用应用健康检查和实际业务页面分别验收。

历史 IIS 安装仍可在 `integration/iis/SopIdentityBridge.cs` 查阅旧身份桥行为。该模块与旧端的 `AllowWrites` 配置配套，Docker 交付使用工作台网关。
