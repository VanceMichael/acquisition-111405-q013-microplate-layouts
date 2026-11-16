# 微孔板读数的布局与测次资料接收

资料接收服务的独立工作副本。支持两类来源：人工摘要领取（`legacy`）与仪器板资料入口（`source`）。source 模式先耐久接收原始测次并向仪器确认，再按测次声明的确切布局版本关联板资料；布局缺失或版本不符时读数保持待确认，重启后从归档原文继续补关联，不重新向仪器索取。

## 环境

Node.js 22，运行与测试只用标准库，无外部服务、数据库、浏览器或联网下载。依赖清单和 npm 锁文件均已提供。

```sh
npm test
npm run demo
```

`npm test` 是初始产品的基线回归，验证现有摘要通路、原文摘要检查、本地来源响应，以及 CLI 在独立进程中的真实领取、重复导入和持久归档检查。该产品是一次执行后退出的采集程序，不提供常驻 HTTP 应用；`npm run collect` 执行领取，`npm run provider` 仅单独启动测试来源。

`npm run acceptance:source` 执行 `test/feature.test.mjs` 中完整的新来源验收；`test/source.test.mjs` 补充耐久重启、修订追加、版本隔离、坐标解释与输入校验的边界回归。交付验证执行 `npm run verify:complete`，让基线、边界与新来源验收同时通过。

```sh
npm run verify:complete
npm run demo:feature
```

正式演示使用完成后的 `npm run demo:feature`，从空临时归档启动本地来源、实际采集并打印结果后退出；无需重放旧日志。`SCENARIO` 可选择 `fixtures/scenarios.json` 中的情景，默认 `serpentine`。单次命令应在90秒内结束，不使用真实客户数据。

## 容器

```sh
docker build -t acquisition-microplate-layouts:local .
docker run --rm --network none acquisition-microplate-layouts:local
docker run --rm --network none acquisition-microplate-layouts:local npm run demo:feature
```

镜像固定 Node.js 版本及基础镜像摘要；首次构建可提前拉取基础镜像，正式运行不安装或下载。容器中来源与采集器同进程启动，不需要第二个容器。默认容器命令跑现有测试与实际摘要导入，不将未开发功能伪装成成功。

## 工作入口

- `src/collector.mjs` 的 `collect` 是业务入口，按 `mode` 分派 `legacy` 与 `source`；既有 `legacy` 模式保留不变。
- `src/source.mjs` 实现 source 模式：耐久接收与确认、布局版本关联、蛇形/朝向坐标解释、修订追加与缺口 issue。
- `src/transport.mjs` 提供原文字节与请求证据，错误状态由业务层判断。
- `src/archive.mjs` 支持内容寻址原文与记录修订，存储位置由调用方传入。
- `provider/server.mjs` 提供允许访问的本地合成来源，路径和例子见 `docs/source-contract.md`。
- `test/feature.test.mjs` 对输出使用局部结构断言，不限制内部模块划分。

`ARCHIVE_DIR` 指定持久目录，`SOURCE_URL` 可连接另行启动的本地来源；两者均未设置时演示自动清理临时目录。`node src/cli.mjs inspect` 配合 `ARCHIVE_DIR` 查看当前索引。不要用来源服务的 fixture 对象直接生成业务结果，真实接收需经 HTTP。
