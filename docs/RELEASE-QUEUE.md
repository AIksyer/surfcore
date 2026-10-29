# 发布待办队列（编辑会话 → 发布会话）

> 用途：编辑会话每完成一批改动，在这里追加**一个带时间戳的批次**：覆盖到哪个提交、
> 改了哪些文件/功能、case 路径、建议版本、可直接复制的交接块。
> **发布会话从最上面的「待发布」批次复制**，不用翻 `git log`；发布完成后把标题改成「已发布 vX.Y.Z」。
>
> 触发：用户说「好了，总结这次的改动」之类的话时追加（规则见 AGENTS 1.6）。
> 没有进这张表的改动，不允许发布（见 [RELEASE.md](RELEASE.md) 第一节）。

---

## 待发布

### 批次 2026-10-29 17:00–18:15 · 语音包离线导入 + 参考音频下载修复 + local/cloud 候选包
<!-- release-batch: start=2026-10-29T17:00+08:00 end=2026-10-29T18:15+08:00 commits=a6dadac -->

**覆盖提交**：`a6dadac`（本批次全部代码/文档）
**覆盖到**：2026-10-29 18:15（+08:00）
**建议**：patch → **0.6.23**（与今天前两批同版）

**case**
- [docs/cases/2026-10-29-voice-pack-offline-import.md](cases/2026-10-29-voice-pack-offline-import.md)
- [docs/cases/2026-10-29-cloud-sample-download.md](cases/2026-10-29-cloud-sample-download.md)

**候选离线包（POC，未上传网盘）**
- `D:\surfcore-poc\release\voice-local-offline-v1.0.0-win-x64.zip`（4.7G，SHA256 `9e0a409dce55da45f3049b4a63e596dc4e0a59e517b61e1b44b2f7ef4e68347c`）
- `D:\surfcore-poc\release\voice-cloud-offline-v1.0.0-win-x64.zip`（249M，SHA256 `8ea837706aacf6867ed454f124f878550a696a1b4ba3da1af53e8e46a47ab7ae`）
- 含微调 age12、GPL 合规目录；无 `config.toml`/密钥；云端 speaker 已清空。

**交接块（复制这一整段给发布会话）**

```text
【发布交接 · 2026-10-29 第三批（17:00–18:15）· 建议并入 v0.6.23】
覆盖提交：a6dadac

一、改了什么
1) 语音包离线导入（local/cloud 共用）
   - 新增 src/voice-pack-import.js：类型/必需文件/manifest sha256/配置/pyvenv 校验；
     copyTree 支持进度/取消，默认只复制、不移动源目录。
   - src/voice-packs.js：inspectImport/startImport/cancelImport/deleteImportSource/
     deleteImportBackup；复制到 .import-*，旧包备份，rename 切换，失败恢复；
     在最终路径改写 pyvenv.cfg；Windows 扫描锁用 120×500ms 重试。
   - src/bridge.js：import-inspect/import/import-cancel/import-delete-source/
     import-delete-backup；ImportError 统一 {code,error,hint,missing,detail}。
   - plugins/surfcore/lib/client.js：导入按钮、确认框（类型/来源/目标/大小/版本/完整性）、
     进度/取消、错误弹窗、源/备份删除；删除旧“手动指定包目录”。
   - plugins/surfcore/lib/index.js：云端参考音频改为 fetch+Blob 下载；新增
     POST /voice/packs/sample-open（explorer /select），解决 target=_blank 没反应。
2) 文档
   - 两个 case、PITFALLS #83/#84/#85、CHANGELOG、HANDOFF、RELEASE 计数 81。

二、测了什么、结果
- npm run test:audit → 81/81
- npm run test:regressions → 全部通过
- plugins/surfcore npm test → 全绿
- node scripts/test-voice-pack-import.mjs → 9/9
- 真实 7.9G 导入：D:/surfcore-poc/stage/voice-local → import-real-packs/voice-local，
  目标 7.6G，源目录保留，pyvenv 指向最终 runtime；.venv/.venv-gsv import 通过。
- 桥接 /api/voice/packs/sample?id=voice-cloud 实测 200 + 922,604B WAV。

三、层级与兼容
- 实现层：导入事务/复制/环境改写；桥接新增只读检查+写操作；插件 UI。
- 接口：新增 import-* 路由；既有接口不变；结构化错误只在 import 链路启用。
- 表现层：设置页导入入口；旧手动指定入口移除。
- 包：候选 zip 仍是 POC 目录，未上传网盘；导入功能在 SurfCore 侧，不要求重打 zip。

四、失败路径
- 类型不符/结构缺失/manifest 哈希不符/目标运行/磁盘不足：导入前拒绝，目标/旧包不动。
- 复制/切换/pyvenv 改写失败：清临时目录、恢复旧包；恢复失败保留 backup 并报
  IMPORT_ROLLBACK_FAILED。
- 取消：只清临时目录；源目录/旧包不动；清理失败报残留路径。
- 无 manifest：先拒绝，用户确认后 allowUnverified 才继续，成功标记 verified:false。

五、没验证
- 设置页实际点击导入/确认框/错误弹窗/删除源/删除备份（需重启 DSH 后手测）。
- DSH 重启后桥接新路由是否生效。
- 真实 7.9G 的取消/旧包恢复现场；UI 的 sample-open（explorer）也未手点。
- 许可：piper GPL、huayan 数据集、age12 微调权重仍待确认；候选包不能直接公开上传。

六、发布时请
- 同步 public 镜像：src/voice-pack-import.js、src/voice-pack-secrets.js、src/voice-packs.js、
  src/bridge.js、scripts/test-voice-pack-import.mjs、scripts/test-audit.mjs、
  plugins/surfcore/lib/{index.js,client.js}、docs/*
- CHANGELOG [Unreleased] 折进 0.6.23
- 重启 DSH 后手测：设置页导入本地/云端包、错误弹窗、参考音频下载/打开目录
- 许可未确认前不要把候选 zip 传到公开网盘
```

**状态**：待发布

### 批次 2026-10-29 13:45–14:30 · 提问回答身份来源 + 主人特权审计 + 权限清单（与上一批同版）
<!-- release-batch: start=2026-10-29T13:45+08:00 end=2026-10-29T14:30+08:00 commits=d976dc0 -->

**覆盖提交**：`d976dc0`（本批次全部改动）
**覆盖到**：2026-10-29 14:30（+08:00）
**建议**：patch → **0.6.23**（与上一批一起发）

**case 文档**
- [docs/cases/2026-10-29-owner-question-audit.md](cases/2026-10-29-owner-question-audit.md)

**交接块（复制这一整段给发布会话）**

```text
【发布交接 · 2026-10-29 第二批（13:45–14:30）· 建议并入 v0.6.23】
覆盖提交：d976dc0

一、改了什么
1) 提问回答带程序身份来源
   - 新增 src/question-answers.js：[仅主人] 判定、谁能消费 pending、按题型编码来源
   - src/bridge.js：registerPending 记 ownerOnly；消费点非主人不消费 owner-only 提问（不吞消息）；
     handlePendingAnswer 按真实 sender 填来源
   - DSH 单选不允许 selected+custom 并存 → 单选 custom("选项文字"+来源) selected=[]；
     多选 selected + custom(来源)
2) 主人特权操作审计
   - 新增 src/owner-audit.js：state/owner-audit.jsonl，1MB×5、90 天清理、跨文件读尾、失败 health
   - src/bridge.js：7 类事件（审批/提问回答/角色切换/封闭模式拒绝/语音/鱼群 bypass/记忆告警）
   - GET /api/owner-audit（console token；agent token 显式 403）；/api/status 暴露 health
3) 插件与 preset
   - lib/index.js：/owner-audit 代理 + /owner-audit/open（固定 state/，无用户输入）
   - lib/client.js：管理员卡「管理操作记录（最近 50 条）」弹窗（操作者打码）
   - dsh/agent-presets/qq-chat-v2/agent.cordis.yml 第 17 条提问分类规则；已重建 preset patch
4) 文档
   - 新增 docs/guides/PERMISSIONS.md；case 2026-10-29-owner-question-audit.md；
     PITFALLS #82、HANDOFF、CHANGELOG、docs/README 索引、RELEASE 计数 80

二、测了什么、结果
- npm run test:audit → 80/80
- npm run test:regressions → 全部通过
- cd plugins/surfcore && npm test → exit 0
- node scripts/test-question-answers.mjs / test-owner-audit.mjs → 通过（含失败分支）

三、层级与兼容
- 实现层：提问编码/消费、审计写入、桥接接线
- 接口：新增只读 GET /api/owner-audit（console token；agent 403），既有接口无破坏；DSH answers 形状按官方约束
- 表现层：设置页弹窗；preset 文本新增一条分类规则

四、失败路径
- 单选 selected 必须为空（否则 DSH bad-response）；owner-only + 非主人不消费 pending；
  审计写入/轮转/清理失败 → health + 限频日志，不静默、不阻塞、不截断；
  审计读取 agent token 一律 403。

五、没验证
- 真实 DSH 问答往返（单选题 custom-only 的模型可见文本）
- 设置页弹窗手点 / 打开文件夹
- preset 安装到 DSH profile + 重启 DSH 后的实际生效提示词
- PERMISSIONS.md 里 5 项「待补程序断言」

六、发布时请
- 同步 public 镜像：src/question-answers.js、src/owner-audit.js、src/bridge.js、
  scripts/{test-audit.mjs,test-question-answers.mjs,test-owner-audit.mjs,audit-bridge-harness.mjs}、
  plugins/surfcore/lib/{index.js,client.js}、plugins/surfcore/presets/qq-chat-v2.patch.yml、
  dsh/agent-presets/qq-chat-v2/agent.cordis.yml、docs/*
- 重启 DSH 后验证 preset 生效与完整问答链路（owner/非主人 × 单选/多选各一次）
- CHANGELOG 的 [Unreleased] 折进 0.6.23
```

**状态**：待发布

### 批次 2026-10-29 11:55–12:35 · SnowLuma 检测 + 失败弹窗 + 云端凭据 + 报错/记录规则
<!-- release-batch: start=2026-10-29T11:55+08:00 end=2026-10-29T12:35+08:00 commits=e07c7e3,161ec97,aa3f7cc,8ef7510,3c4bc5a -->

**覆盖提交**：`e07c7e3`（云端凭据）、`161ec97`（SnowLuma 检测）、`aa3f7cc`（记录规则）、
`8ef7510`（失败弹窗）、`3c4bc5a`（报错规范）、以及本文档所在的提交（队列机制）。
**覆盖到**：2026-10-29 12:35（+08:00）—— 本批次最后一次提交。
**建议**：patch → **0.6.23**

**case 文档**
- [docs/cases/2026-10-29-voice-cloud-credentials.md](cases/2026-10-29-voice-cloud-credentials.md)
- [docs/cases/2026-10-29-snowluma-detect-manual-path.md](cases/2026-10-29-snowluma-detect-manual-path.md)

**交接块（复制这一整段给发布会话）**

```text
【发布交接 · 2026-10-29 批次 · 建议 v0.6.23（patch）】

一、改了什么
1) 云端语音包凭据边界（e07c7e3）
   - src/voice-packs.js：stripCloudCredentials / ensurePackConfig；新装清空 cloud_app_id/cloud_access_key，
     重装保留用户填的；start() 未配置拒绝启动；list() 暴露 needsCloudConfig
   - plugins/surfcore/lib/client.js、public/console.html：装后引导、通用 placeholder、待填提示
   - 回归 scripts/test-voice-cloud-credentials.mjs（26 断言 + 4 rejections，已进 test:audit）
2) SnowLuma 检测（161ec97）
   - 新增 plugins/surfcore/lib/snowluma-install.js（归一 / 候选 / tried）
   - plugins/surfcore/lib/index.js：detect-snowluma 可选 path；显式路径只校验它、不回退猜测
   - plugins/surfcore/lib/client.js：概览 SnowLuma 卡「浏览…」
   - 回归 plugins/surfcore/scripts/test-snowluma-install.mjs（已进 npm test）
3) 失败弹窗 + 结构化错误（8ef7510）
   - snowLumaMissingReport（code/title/error/hint/tried）；前端 ErrorModal；网络异常也弹窗
   - 同一测试文件扩到 30 项（其中 8 项专测失败报告）
4) 规则与流程（aa3f7cc / 3c4bc5a / 本文档）
   - AGENTS 1.6（讲透逻辑+记录+交接块）、1.7（失败必须可见可行动）
   - docs/guides/ERROR-REPORTING.md、docs/RELEASE.md 交接格式、docs/cases/_TEMPLATE.md、docs/RELEASE-QUEUE.md

二、测了什么、结果
- npm run test:audit → 78/78
- cd plugins/surfcore && npm test → exit 0
- node scripts/test-voice-cloud-credentials.mjs → 通过（26+4）；临时目录读取加 EBUSY/ENOENT 重试
  （Windows Defender/索引器会短暂占住刚写的 config.toml，之前的 77/78 假红是环境抖动，不是产品失败）
- node plugins/surfcore/scripts/test-snowluma-install.mjs → 30 项通过

三、改动层级与兼容
- 云端凭据：实现层（安装清洗 / 启动闸），无接口语义变化
- SnowLuma：实现层 + 接口只加可选 path、失败响应加 code/title/hint/tried（向后兼容）+ UI
- config.json 无新增必填字段；snowluma.launcherPath 语义不变

四、失败路径
- 云端包未配置：start 被拒并提示填三项；检测失败：ErrorModal（试过位置可展开 + 浏览/下载两个按钮）
- 失败分支均有断言

五、没验证
- 真机从 GitHub 公开包全新安装语音（会真下依赖）
- 真机点「浏览…」原生框 / 看失败弹窗（需要桌面会话）
- 公开镜像 surfvoicecloud / surfvoicelocal 的 config.example.toml 里的真实 AppID 未改（编辑器不碰公开仓库）

六、发布时请
- 同步 public 镜像：plugins/surfcore/lib/{client.js,index.js,snowluma-install.js}、
  plugins/surfcore/scripts/test-snowluma-install.mjs、plugins/surfcore/package.json（测试链）
- 把公开镜像两个 config.example.toml 的 cloud_app_id 换成占位符
- CHANGELOG 的 [Unreleased] 折进 0.6.23
```

**状态**：待发布

---

## 已发布

（空）
