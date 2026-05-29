<!-- language-tabs -->

[🇨🇳 中文](#chinese) | [🇬🇧 English](#english)

---

<a id="chinese"></a>

```
███████╗██╗  ██╗ ██████╗ 
██╔════╝╚██╗██╔╝██╔═══██╗
█████╗   ╚███╔╝ ██║   ██║
██╔══╝   ██╔██╗ ██║   ██║
███████╗██╔╝ ██╗╚██████╔╝
╚══════╝╚═╝  ╚═╝ ╚═════╝ 
```

> 🛸 浏览器端全栈智能体。MCTS深度规划 · 流水线多Agent调度 · 世界离散验证 · 自进化技能载入。**你的外脑。**

---

## 这是什么

Exo 是一个运行在浏览器中的自主AI Agent。**单HTML文件，零后端，全本地。**

它不仅仅是一个聊天机器人。它是一个完整的智能体操作系统：

- 🧬 **MCTS 深度规划** — 蒙特卡洛树搜索，最多600次仿真，UCB1+信息素，收敛检测
- 🏭 **流水线引擎 V5** — DAG编排多子Agent并行协作，10种节点类型，条件路由，报告门暂停决策
- 🌍 **世界验证器** — 多实体离散事件仿真，嵌套子状态，深历史恢复，正交区域，守卫条件
- 🧠 **自进化** — 后台反思→技能生成→验证→自动加载，完整遗传算法循环
- 📚 **记忆/知识系统** — 语义记忆+长期记忆+知识库+语义搜索+对话压缩
- 🔧 **40+内置工具** — 搜索、文件系统、代码执行、图表、SQLite、OCR、PDF、邮件、语音…

---

## 架构总览

```
┌──────────────────────────────────────────────────────────┐
│                    EXO 浏览器端架构                        │
├──────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ MCTS     │  │ Pipeline │  │ World     │  │ Self-    │  │
│  │ Planner  │  │ Engine   │  │ Validator │  │ Evolution│  │
│  │ (UCB1+   │  │ (DAG+    │  │ (Nested+  │  │ (Skill    │  │
│  │  Pheromone│  │  Critic) │  │  Regions) │  │  Generate)│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │              │       │
│  ┌────┴──────────────┴──────────────┴──────────────┴────┐  │
│  │              Tool Gateway (40+ tools)                │  │
│  │  search │ filesystem │ sql_db │ chart │ ocr │ pdf    │  │
│  │  speech │ calendar │ email │ archive │ mcp │ api     │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────┴───────────────────────────────┐  │
│  │         IndexedDB Filesystem (虚拟文件系统)           │  │
│  │  /config/ │ /worlds/ │ /pipelines/ │ /skills/        │  │
│  │  /memory/ │ /kb/     │ /downloads/ │ /uploads/       │  │
│  └──────────────────────┬───────────────────────────────┘  │
│                         │                                  │
│  ┌──────────────────────┴───────────────────────────────┐  │
│  │     Worker Pool (evoWorker + taskWorker)              │  │
│  │     Web Worker × 2, SharedArrayBuffer, Atomics        │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 核心子系统

### 🧬 MCTS 深度规划器

```
                        [Root: 问题]
                       /    |    \
                    A₁     A₂     A₃    ← 扩展LLM生成候选
                    / \     |     / \
                   B₁ B₂   B₃   C₁ C₂ ← 选择(UCB1+信息素)
                   |        |     |
                   ...      ...   ...  ← 评估LLM打分
                                       
              backpropagate ↑ 反向传播价值
              evaporate     ↑ 信息素挥发
              converge?     ↑ 遗憾率+stddev收敛检测
```

**两种模式:**
| 模式 | 仿真数 | 最大深度 | 并发 | 思考 |
|------|--------|---------|------|------|
| `fast` | 150 | 4 | 12 | ❌ |
| `standard` | 600 | 6 | 20 | ✅ |

**技术细节:**
- 混合价值函数: Q_local(单步) + Q_global(整路径) 双重信息素更新
- VL_WEIGHT 虚拟损失防止重复探索同一分支
- 收敛检测: `regret_ratio < 0.05 AND value_stddev < 0.02 AND min_root_visits >= 30`
- 资源感知: DEATH_PENALTY 惩罚高消耗路径, CYCLE_SIMILARITY 检测循环
- 内置 Token 预算控制, 防止单次搜索烧掉配额

---

### 🏭 流水线引擎 V5

```
┌──────────────────────────────────────────────────────────┐
│ 主Agent                    子Agent池 (信号量滑动调度)      │
│                                                          │
│  create(DAG) ──→ run() ──→ ┌──────┐  ┌──────┐          │
│       ↑                    │Agent₁│  │Agent₂│  ...     │
│       │                    │critic│  │critic│          │
│       │                    └──┬───┘  └──┬───┘          │
│       │                       ↓          ↓              │
│  report_gate ←──────────  evaluation ← test_gate       │
│   (暂停决策)                  │          │(失败回注)      │
│       │                       ↓          ↓              │
│  approve/revise          assembly ← report_gate        │
│  /reroute/abort          (cross-verify,                │
│       │                   voting/weighted/             │
│       ↓                   best_parts merge)             │
│   交付(deliver)                                         │
└──────────────────────────────────────────────────────────┘
```

**10种节点类型:**

| 类型 | 功能 | 技术亮点 |
|------|------|---------|
| `agent` | 独立子Agent | 内置critique_loop(评估→修正,最多3轮), pass_threshold 控制 |
| `parallel_group` | 并行组 | 信号量并发池, all/best_of_n/race 三种策略 |
| `report_gate` | 报告门 | 暂停DAG, 收集全链路追溯, 主Agent人工/LLM决策 |
| `evaluation` | 评估节点 | 多维加权评分, 强制结构化输出(0.3-0.7正态分布) |
| `test_gate` | 测试门 | 失败自动回注修正(max_retries次), 超限升级报告门 |
| `assembly` | 拼接节点 | 交叉验证+best_parts/voting/weighted三策略融合 |
| `reqalign` | 需求对齐 | LLM分析模糊维度→问卷→收敛度评估(6维)→确认书→锁定 |
| `generatespec` | 开发文档生成 | §1-§7 完整开发文档, 极严格子Agent审查(0-10评分) |

**条件边:**
- 递归深度字段搜索(不需要加 `output.` / `metrics.` 前缀)
- 支持 `>=` `<=` `>` `<` `==` `!=`
- 不满足→`skipped_by_cond`, 含详细trace

---

### 🌍 世界验证器 (World Validator)

```
┌─────────────────────────────────────────────┐
│  多实体离散事件仿真引擎                       │
│                                             │
│  entity: machine        entity: water_tank  │
│  ┌───┐  heat  ┌────┐   ┌───┐  drain  ┌───┐ │
│  │idle│──────→│brew│   │full│───────→│low │ │
│  └───┘       └────┘   └───┘        └───┘ │
│    │           │  nested:   interactions:   │
│    │           │  ┌──────┐  water_tank      │
│    │           │  │steam │  .drain →        │
│    │           │  │ purge│  machine          │
│    │           │  └──────┘  .water_alert    │
│    │           │                            │
│  history_type:"deep"  → 自动恢复最深子状态   │
└─────────────────────────────────────────────┘
```

**15个action**, 支持: JSON/YAML/NL/CSV/UML 输入, Mermaid/PlantUML/Graphviz/CSV 输出

**特性:**
- 嵌套子状态(nested): 进入父状态→自动初始化子状态机
- 深历史恢复: 离开时保存`_nested_history`, 再次进入自动恢复
- 正交区域(regions): 独立路由事件到各区域状态机
- 守卫条件: 变量绑定(`water_level>50`), 返回`guard_denied`+失败表达式
- 跨实体事件: `interactions[{from_entity, on_event, to_entity, trigger}]`
- pending队列: 不匹配事件最多重试1次后丢弃, 显式transition事件优先
- 热修改: `edit` 直接改定义+运行时context, 快捷写法`edit(wid, {context:{...}})`

---

### 🧠 自进化系统

```
┌─────────────────────────────────────────────┐
│          Self-Evolution Pipeline             │
│                                             │
│  task_success ──→ evoWorker                 │
│       │              │                      │
│       │         ┌────┴────┐                 │
│       │         │reflect  │ 分析失败/成功    │
│       │         │pattern  │ 提取模式         │
│       │         └────┬────┘                 │
│       │              │                      │
│       │         ┌────┴────┐                 │
│       │         │generate │ 生成skill候选    │
│       │         │validate │ schema验证       │
│       │         └────┬────┘                 │
│       │              │                      │
│       │         ┌────┴────┐                 │
│       │         │evaluate │ A/B测试+judge    │
│       │         │(3 judges│ 多维度评分       │
│       │         │ random) │                  │
│       │         └────┬────┘                 │
│       │              │                      │
│       │    pass? ──→ save to /skills/       │
│       │    fail? ──→ discard (EVAL_FAILED)  │
│       │                                     │
│  skill_manager ──→ list/set/reset            │
│  (运行时动态技能注入系统指令)                  │
└─────────────────────────────────────────────┘
```

---

### 📚 记忆系统

| 系统 | 用途 | 谁写谁读 |
|------|------|---------|
| `semantic_memory` | 搜索历史对话 | 只读, MBSRP+HYPERMEM混合检索 |
| `longterm_memory` | AI私人笔记 | AI写AI读, 语义搜索+分类 |
| `knowledge_base` | 用户共享知识 | 用户传AI读, AI创建的可自管 |

- 长对话压缩: 超阈值自动LLM摘要, 保留最近6条原文
- 对话级状态隔离: `convStates[convId]`, 每个对话独立处理状态

---

## 全部工具清单 (40+)

```
search            filesystem        calculator        chart
diagram           svg_animator      file_upload       fuzzy_search
mcts_plan         ocr               semantic_memory   longterm_memory
knowledge_base    skill_manager     pdf_read          pdf_generate
custom_api_call   mcp_connect       user_function_call convert_format
geo_search        geo_geocode       geo_ip            send_email
sql_db            browser_notify    archive           speech_tts
speech_stt        calendar          precise_time      pipeline
reqalign          generatespec      world_validator   table_generator
word_generator
```

---

## 技术难点与设计决策

### 1. 单HTML零构建
12808行, 640KB+ 的单个HTML文件。无npm, 无webpack, 无构建工具。所有外部库(18个)通过CDN动态加载, 懒加载策略(`loadOnStart:false`)。

### 2. Worker沙箱执行
`code_run` 在taskWorker内通过 `new Function()` 沙箱执行, 主线程zero eval。Web Worker通过 `postMessage` + `SharedArrayBuffer` + `Atomics` 同步等待。

### 3. Base64 Worker消除转义问题
V4重构: Worker代码Base64编码 → `importScripts('data:application/javascript;base64,...')`, 消除多层转义地狱。

### 4. 对话级状态隔离
`convStates[convId]` — `isProcessing`/`stopRequested`/`llmController` 全部通过 `window` 属性代理自动路由到当前对话。多对话并行, 切换无状态污染。

### 5. 递归字段搜索
Pipeline条件边 `_evalEdge`: 递归遍历 `ns → ns.output → ns.metrics → ns.output.output → 各子对象`, 深度≤4。用户不加前缀也能匹配。

### 6. 信号量滑动调度
`_execParallelGroup`: 子任务池 `_launchOne()` 递归自调度—完成一个立即启动下一个, 保持并发数恒定, 无需预先创建固定线程池。

---

## 快速开始

1. 下载 `index.html`
2. 双击打开 (或用 `python -m http.server` 启动本地服务器)
3. 设置 → API配置 → 填入 DeepSeek API Key
4. 开始对话

**无需安装任何东西。纯浏览器运行。**

---

## 依赖

所有依赖通过CDN动态加载:
`markdown-it` `KaTeX` `highlight.js` `Mermaid` `ECharts` `SheetJS` `docx` `Fuse.js` `pako` `Ajv` `YAML` `mathjs` `PDF.js` `mammoth` `PptxJs` `JSZip` `Tesseract.js` `sql.js` `meSpeak` `html2pdf`

---

<a id="english"></a>

```
███████╗██╗  ██╗ ██████╗ 
██╔════╝╚██╗██╔╝██╔═══██╗
█████╗   ╚███╔╝ ██║   ██║
██╔══╝   ██╔██╗ ██║   ██║
███████╗██╔╝ ██╗╚██████╔╝
╚══════╝╚═╝  ╚═╝ ╚═════╝ 
```

> 🛸 Browser-native full-stack AI agent. MCTS planning · Pipeline orchestration · World simulation · Self-evolution. **Your external brain.**

---

## What is Exo

Exo is an autonomous AI agent that runs entirely in your browser. **Single HTML file. Zero backend. Fully local.**

It's not just a chatbot. It's a complete agent operating system.

---

## Architecture

See the [Chinese section](#chinese) for the full architecture diagram.

| Subsystem | Description |
|-----------|-------------|
| **MCTS Planner** | Monte Carlo Tree Search, UCB1 + pheromone, convergence detection, 2 modes (fast/standard) |
| **Pipeline Engine V5** | DAG orchestration, 10 node types, conditional routing, critique loops, report gates, assembly |
| **World Validator** | Multi-entity discrete event simulation, nested substates, deep history, orthogonal regions |
| **Self-Evolution** | Background reflection → skill generation → validation → auto-loading, genetic algorithm cycle |
| **Memory/Knowledge** | Semantic memory + long-term memory + knowledge base, context compression |
| **40+ Built-in Tools** | Search, filesystem, code execution, charts, SQLite, OCR, PDF, email, speech… |

---

## Quick Start

1. Download `index.html`
2. Open it (or serve with `python -m http.server`)
3. Settings → API Config → enter your DeepSeek API Key
4. Start chatting

**No installation required. Runs purely in the browser.**

---

## License

MIT
