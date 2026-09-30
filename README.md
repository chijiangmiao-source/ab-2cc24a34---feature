# 光阑换位操作可导出性审计

工程师在光学载荷检修时确认：一组**允许的光阑换位操作**能否实际导出**目标接线次序**，
避免把看似相同的端口排列误当成可执行规程。

- 录入 **2–12 个稳定端口**、**至多 8 个具名置换操作**及一个**目标置换**；
- 页面返回 **“可导出”** 与可逐步回放的操作因子链；
- 或返回**首个无法继续归约的端口层**及其轨道证据（基点像不在该层轨道内）。

核心计算在 **Web Worker** 中按**端口标识排序**建立**确定性 Schreier–Sims 稳定子链**；
成员结论由各层**横截代表逐层剥离复算**，因子词再逐操作乘回独立校验——
不枚举全部操作串、不使用随机搜索、不以有限深度回放代替。

## 置换记法

| 形式 | 示例 | 说明 |
| --- | --- | --- |
| 循环记号 | `(A B C)(D E)` | A→B→C→A，D↔E；未出现的端口为固定点 |
| 显式映射 | `A->B, B->C, C->A` | 接受 `->` `→` `=>` `:`；必须覆盖全部端口 |

每个操作必须是端口集合上的**双射**。重复操作名、缺失端口、非双射映射、非法目标等
**全部错误一次性返回**，且任何输入改动都**立即撤销旧结论**。

## 快速开始（Docker Compose）

```bash
# 默认宿主机端口 8080
docker compose up --build

# 自定义宿主机端口
HOST_PORT=9090 docker compose up --build
# 或
cp .env.example .env   # 编辑 HOST_PORT
docker compose up --build
```

打开 http://localhost:8080 ，健康探针： http://localhost:8080/healthz

## verify 服务（一次性，按状态码报告）

```bash
docker compose build
docker compose run --rm verify
```

`verify` 依赖 `web` 服务健康检查通过后启动，依次执行：

1. **代码测试**（`node --test`，23 项）——含一份可导出规程、一份不可导出目标、
   与全枚举 BFS 对 n≤5 全部目标的成员结论对照、A5=60 阶、S12=12! 阶、
   全量校验错误聚合、Worker 协议往返等；
2. **构建检查**——全部 JS `node --check`、静态资源引用完整性、核心 API 导出；
3. **HTTP 冒烟**——`/healthz`、审计页、静态资源、路径穿越拒绝、404。

全部通过退出码 0，任一失败非零退出，随后容器退出（不长期驻留）。

本地无 Docker 时等价运行：

```bash
npm test                 # 代码测试
npm run build            # 构建检查
PORT=8080 node server.js # 起服务（另一终端）
BASE_URL=http://127.0.0.1:8080 node verify/http-smoke.js
```

## 算法说明（确定性 Schreier–Sims）

- 基点顺序固定为端口标识排序后的 `[0,1,…,n-1]`；
- 每层 `i` 维护强生成元集 `S[i]`、基点轨道及**横截代表**（含对应的生成元词）；
- 初始生成元按操作名排序后逐条剥离；用 Schreier 生成元
  `β(x)·g·β(g(x))⁻¹` 反复闭合直至无新点、无新残差（确定性顺序、有限终止）；
- 目标剥离：逐层以横截代表之逆消去基点像；像点不在轨道内即给出
  **首个阻塞端口层 + 轨道证据**；全部基点消去为恒等则成员成立；
- 因子词 `target = t_{n-1}·…·t_0` 按可执行顺序展开，供逐步回放，并独立乘回复核。

## 并发与代次隔离

每次提交递增 `requestId`（代次）。计算未结束时改写规程会使代次前移并撤销旧结论；
旧 Worker 回包代次不匹配即被丢弃，**不会覆盖新输入或新结论**。

## 目录

```
public/core.js     纯函数核心（解析/校验/稳定子链/成员判定/因子链），Worker 与 Node 测试共用
public/worker.js   Web Worker：按 requestId 回包
public/app.js      页面逻辑、代次隔离、结论渲染、逐步回放
public/index.html  审计页面
server.js          静态服务 + /healthz
tests/             node:test 代码测试（含 Worker vm 往返）
scripts/           构建检查
verify/            HTTP 冒烟与 verify 编排
docker-compose.yml web（HOST_PORT 可配）+ verify（一次性，状态码报告）
```
